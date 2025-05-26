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
  
  try {
    const { url } = JSON.parse(event.body || '{}');
    if (!url) throw new Error("No URL provided");

    // Use unique filenames
    const timestamp = Date.now();
    inPath = path.join(os.tmpdir(), `in_${timestamp}.m4a`);
    outPath = path.join(os.tmpdir(), `out_${timestamp}.mp3`);

    console.log('Starting conversion for:', url);
    
    // Download with shorter timeout and streaming
    const downloadStart = Date.now();
    const resp = await axios.get(url, { 
      responseType: 'stream',
      timeout: 8000, // 8 second download timeout
      maxContentLength: 50 * 1024 * 1024 // 50MB limit
    });
    
    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(inPath);
      resp.data.pipe(writeStream);
      
      writeStream.on('finish', () => {
        const downloadTime = Date.now() - downloadStart;
        const fileSize = fs.statSync(inPath).size;
        console.log(`Download completed in ${downloadTime}ms, size: ${fileSize} bytes`);
        resolve();
      });
      
      writeStream.on('error', reject);
      resp.data.on('error', reject);
      
      // Additional timeout safety
      setTimeout(() => reject(new Error('Download timeout')), 9000);
    });

    // Quick file validation
    const inputStats = fs.statSync(inPath);
    if (inputStats.size === 0) {
      throw new Error("Downloaded file is empty");
    }

    console.log('Starting FFmpeg conversion...');
    const conversionStart = Date.now();
    
    // Optimized conversion settings for speed
    await new Promise((resolve, reject) => {
      ffmpeg(inPath)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate('96k')  // Lower bitrate for faster processing
        .audioFrequency(22050) // Lower frequency for speed
        .audioChannels(1)     // Mono for speed (remove if stereo needed)
        .outputOptions([
          '-ac', '1',         // Mono
          '-ar', '22050',     // Sample rate
          '-b:a', '96k',      // Bitrate
          '-f', 'mp3'         // Force format
        ])
        .output(outPath)
        .on('start', (cmd) => {
          console.log('FFmpeg started:', cmd.substring(0, 100) + '...');
        })
        .on('end', () => {
          const conversionTime = Date.now() - conversionStart;
          console.log(`Conversion completed in ${conversionTime}ms`);
          resolve();
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err.message);
          reject(err);
        })
        .run();
    });

    // Verify output
    if (!fs.existsSync(outPath)) {
      throw new Error("Output file not created");
    }

    const outputStats = fs.statSync(outPath);
    if (outputStats.size === 0) {
      throw new Error("Output file is empty");
    }

    const totalTime = Date.now() - startTime;
    console.log(`Total processing time: ${totalTime}ms, output size: ${outputStats.size} bytes`);

    // Check if we're close to timeout
    if (totalTime > 20000) { // 20 seconds
      console.warn('Processing took longer than expected, may timeout');
    }

    // Read and return
    const mp3 = fs.readFileSync(outPath);
    
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": "attachment; filename=\"converted.mp3\"",
        "Content-Length": mp3.length.toString(),
        "X-Processing-Time": totalTime.toString()
      },
      body: mp3.toString('base64'),
      isBase64Encoded: true,
    };
    
  } catch (err) {
    const totalTime = Date.now() - startTime;
    console.error(`Error after ${totalTime}ms:`, err.message);
    
    return { 
      statusCode: 500, 
      body: JSON.stringify({ 
        error: err.message,
        processingTime: totalTime
      }) 
    };
  } finally {
    // Quick cleanup
    try {
      if (inPath && fs.existsSync(inPath)) fs.unlinkSync(inPath);
      if (outPath && fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch (e) {
      console.error('Cleanup error:', e.message);
    }
  }
};