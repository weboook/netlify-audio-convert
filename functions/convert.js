const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

exports.handler = async (event) => {
  let inPath, outPath;
  const startTime = Date.now();
  const MAX_PROCESSING_TIME = 20000; // 20 seconds max
  
  try {
    const { url } = JSON.parse(event.body || '{}');
    if (!url) throw new Error("No URL provided");

    const timestamp = Date.now();
    inPath = path.join(os.tmpdir(), `in_${timestamp}.m4a`);
    outPath = path.join(os.tmpdir(), `out_${timestamp}.mp3`);

    console.log('Starting conversion for:', url);
    
    // Download the file with stricter limits
    const downloadStart = Date.now();
    const resp = await axios.get(url, { 
      responseType: 'stream',
      timeout: 10000, // Reduced timeout
      maxContentLength: 25 * 1024 * 1024, // Reduced to 25MB max
      maxRedirects: 3
    });
    
    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(inPath);
      resp.data.pipe(writeStream);
      
      const timeout = setTimeout(() => {
        writeStream.destroy();
        reject(new Error('Download timeout'));
      }, 8000);
      
      writeStream.on('finish', () => {
        clearTimeout(timeout);
        const downloadTime = Date.now() - downloadStart;
        const fileSize = fs.statSync(inPath).size;
        console.log(`Download completed in ${downloadTime}ms, size: ${fileSize} bytes`);
        resolve();
      });
      
      writeStream.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      resp.data.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Verify input file
    const inputStats = fs.statSync(inPath);
    if (inputStats.size === 0) {
      throw new Error("Downloaded file is empty");
    }

    // Check if we have enough time left for conversion
    const timeElapsed = Date.now() - startTime;
    if (timeElapsed > MAX_PROCESSING_TIME * 0.6) {
      throw new Error("Insufficient time remaining for conversion");
    }

    console.log('Starting FFmpeg conversion...');
    const conversionStart = Date.now();
    
    // Optimized FFmpeg conversion with timeout
    await new Promise((resolve, reject) => {
      const conversionTimeout = setTimeout(() => {
        reject(new Error('FFmpeg conversion timeout'));
      }, MAX_PROCESSING_TIME - timeElapsed - 2000); // Leave 2s buffer

      const ffmpegProcess = ffmpeg(inPath)
        .inputFormat('m4a')
        .audioCodec('libmp3lame')
        .noVideo()
        .audioBitrate('128k')        // Standard quality
        .audioFrequency(44100)       
        .audioChannels(2)            
        .format('mp3')
        .outputOptions([
          '-preset', 'ultrafast',    // Fastest encoding preset
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
        });

      ffmpegProcess.run();
    });

    // Verify output file exists and has content
    if (!fs.existsSync(outPath)) {
      throw new Error("FFmpeg did not create output file");
    }

    const outputStats = fs.statSync(outPath);
    if (outputStats.size === 0) {
      throw new Error("FFmpeg created empty output file");
    }

    // Quick validation - just check file size is reasonable
    if (outputStats.size < 1000) {
      throw new Error("Output file suspiciously small");
    }

    // Read the file
    const buffer = fs.readFileSync(outPath);
    
    const totalTime = Date.now() - startTime;
    console.log(`Total processing: ${totalTime}ms, output: ${outputStats.size} bytes`);

    // Check if we're approaching timeout
    if (totalTime > MAX_PROCESSING_TIME * 0.9) {
      console.warn('Conversion completed close to timeout limit');
    }

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
    
    // Return more specific error info
    let errorMessage = err.message;
    if (err.message.includes('timeout') || err.message.includes('Timeout')) {
      errorMessage = "File too large or conversion taking too long. Try a smaller file.";
    } else if (err.message.includes('ENOTFOUND') || err.message.includes('network')) {
      errorMessage = "Could not download the source file. Check the URL.";
    }
    
    return { 
      statusCode: err.message.includes('timeout') ? 504 : 500,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ 
        error: errorMessage,
        processingTime: totalTime,
        originalError: err.message
      }) 
    };
  } finally {
    // Cleanup - more aggressive cleanup
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