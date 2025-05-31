const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');

// Use @ffmpeg-installer instead of ffmpeg-static
let ffmpegPath;
try {
  ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
  console.log('Using @ffmpeg-installer, FFmpeg path:', ffmpegPath);
  ffmpeg.setFfmpegPath(ffmpegPath);
} catch (error) {
  console.error('Failed to load @ffmpeg-installer:', error.message);
  throw new Error('FFmpeg installer not available. Please ensure @ffmpeg-installer/ffmpeg is installed.');
}

exports.handler = async (event) => {
  let inPath, outPath;
  const startTime = Date.now();
  const MAX_PROCESSING_TIME = 22000; // 22 seconds max
  
  try {
    // Verify FFmpeg is working
    try {
      console.log('Testing FFmpeg installation...');
      await new Promise((resolve, reject) => {
        const testTimeout = setTimeout(() => {
          reject(new Error('FFmpeg test timeout'));
        }, 3000);
        
        ffmpeg.ffprobe('-version', (err, data) => {
          clearTimeout(testTimeout);
          if (err) {
            console.error('FFmpeg test failed:', err.message);
            reject(err);
          } else {
            console.log('FFmpeg test successful');
            resolve(data);
          }
        });
      });
    } catch (testError) {
      console.error('FFmpeg verification failed:', testError.message);
      throw new Error(`FFmpeg is not working: ${testError.message}`);
    }

    const { url } = JSON.parse(event.body || '{}');
    if (!url) throw new Error("No URL provided");

    const timestamp = Date.now();
    inPath = path.join(os.tmpdir(), `in_${timestamp}.m4a`);
    outPath = path.join(os.tmpdir(), `out_${timestamp}.mp3`);

    console.log('Starting conversion for:', url);
    
    // Download the file
    const downloadStart = Date.now();
    console.log('Downloading file...');
    
    const resp = await axios.get(url, { 
      responseType: 'stream',
      timeout: 8000,
      maxContentLength: 25 * 1024 * 1024, // 25MB max
      maxRedirects: 3,
      headers: {
        'User-Agent': 'Netlify-Audio-Converter/1.0'
      }
    });
    
    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(inPath);
      resp.data.pipe(writeStream);
      
      const downloadTimeout = setTimeout(() => {
        writeStream.destroy();
        reject(new Error('Download timeout'));
      }, 6000);
      
      writeStream.on('finish', () => {
        clearTimeout(downloadTimeout);
        const downloadTime = Date.now() - downloadStart;
        const fileSize = fs.statSync(inPath).size;
        console.log(`Download completed in ${downloadTime}ms, size: ${fileSize} bytes`);
        resolve();
      });
      
      writeStream.on('error', (err) => {
        clearTimeout(downloadTimeout);
        reject(err);
      });
      
      resp.data.on('error', (err) => {
        clearTimeout(downloadTimeout);
        reject(err);
      });
    });

    // Verify input file
    const inputStats = fs.statSync(inPath);
    if (inputStats.size === 0) {
      throw new Error("Downloaded file is empty");
    }

    // Check remaining time
    const timeElapsed = Date.now() - startTime;
    const remainingTime = MAX_PROCESSING_TIME - timeElapsed;
    
    if (remainingTime < 5000) {
      throw new Error("Insufficient time remaining for conversion");
    }

    console.log(`Starting conversion with ${remainingTime}ms remaining...`);
    const conversionStart = Date.now();
    
    // Convert using fluent-ffmpeg with optimized settings
    await new Promise((resolve, reject) => {
      const conversionTimeout = setTimeout(() => {
        reject(new Error('FFmpeg conversion timeout'));
      }, remainingTime - 2000); // Leave 2s buffer

      ffmpeg(inPath)
        .inputFormat('m4a')
        .audioCodec('libmp3lame')
        .noVideo()
        .audioBitrate('128k')
        .audioFrequency(44100)
        .audioChannels(2)
        .format('mp3')
        .outputOptions([
          '-preset', 'ultrafast',    // Fastest encoding
          '-q:a', '4',              // Good quality/speed balance
          '-map', '0:a:0'           // Map first audio stream only
        ])
        .output(outPath)
        .on('start', (cmd) => {
          console.log('FFmpeg command:', cmd);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`Progress: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          clearTimeout(conversionTimeout);
          const conversionTime = Date.now() - conversionStart;
          console.log(`Conversion completed in ${conversionTime}ms`);
          resolve();
        })
        .on('error', (err) => {
          clearTimeout(conversionTimeout);
          console.error('FFmpeg error:', err.message);
          reject(new Error(`FFmpeg conversion failed: ${err.message}`));
        })
        .run();
    });

    // Verify output
    if (!fs.existsSync(outPath)) {
      throw new Error("Conversion did not create output file");
    }

    const outputStats = fs.statSync(outPath);
    if (outputStats.size === 0) {
      throw new Error("Conversion created empty output file");
    }

    if (outputStats.size < 1000) {
      throw new Error("Output file suspiciously small - conversion may have failed");
    }

    // Read and return the file
    const buffer = fs.readFileSync(outPath);
    
    const totalTime = Date.now() - startTime;
    console.log(`Total processing: ${totalTime}ms, output: ${outputStats.size} bytes`);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": "attachment; filename=\"converted.mp3\"",
        "Content-Length": buffer.length.toString(),
        "X-Processing-Time": totalTime.toString(),
        "Cache-Control": "no-cache"
      },
      body: buffer.toString('base64'),
      isBase64Encoded: true,
    };
    
  } catch (err) {
    const totalTime = Date.now() - startTime;
    console.error(`Error after ${totalTime}ms:`, err.message);
    
    // Enhanced error messages
    let errorMessage = err.message;
    let statusCode = 500;
    
    if (err.message.includes('timeout') || err.message.includes('Timeout')) {
      errorMessage = "File too large or conversion taking too long. Try a smaller file.";
      statusCode = 504;
    } else if (err.message.includes('ENOTFOUND') || err.message.includes('network')) {
      errorMessage = "Could not download the source file. Check the URL and ensure it's accessible.";
      statusCode = 400;
    } else if (err.message.includes('FFmpeg') || err.message.includes('ffmpeg')) {
      errorMessage = "Audio conversion failed. The file may be corrupted or in an unsupported format.";
      statusCode = 422;
    } else if (err.message.includes('installer')) {
      errorMessage = "Audio conversion service temporarily unavailable. Please try again later.";
      statusCode = 503;
    }
    
    return { 
      statusCode: statusCode,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ 
        error: errorMessage,
        processingTime: totalTime,
        debug: err.message // Keep original error for debugging
      }) 
    };
  } finally {
    // Cleanup
    const cleanupFiles = [inPath, outPath];
    for (const filePath of cleanupFiles) {
      try {
        if (filePath && fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log('Cleaned up:', filePath);
        }
      } catch (e) {
        console.error('Cleanup error for', filePath, ':', e.message);
      }
    }
  }
};