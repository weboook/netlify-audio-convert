const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

exports.handler = async (event) => {
  let inPath, outPath;
  
  try {
    const { url } = JSON.parse(event.body || '{}');
    if (!url) throw new Error("No URL provided");

    // Use unique filenames to avoid conflicts
    const timestamp = Date.now();
    inPath = path.join(os.tmpdir(), `in_${timestamp}.m4a`);
    outPath = path.join(os.tmpdir(), `out_${timestamp}.mp3`);

    console.log('Downloading from:', url);
    
    // Download M4A with better error handling
    const resp = await axios.get(url, { 
      responseType: 'stream',
      timeout: 30000, // 30 second timeout
      maxContentLength: 100 * 1024 * 1024 // 100MB limit
    });
    
    // Wait for download to complete
    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(inPath);
      resp.data.pipe(writeStream);
      
      writeStream.on('finish', () => {
        console.log('Download completed, file size:', fs.statSync(inPath).size, 'bytes');
        resolve();
      });
      
      writeStream.on('error', reject);
      resp.data.on('error', reject);
    });

    // Verify input file exists and has content
    const inputStats = fs.statSync(inPath);
    if (inputStats.size === 0) {
      throw new Error("Downloaded file is empty");
    }

    console.log('Starting conversion...');
    
    // Convert to MP3 with better settings and error logging
    await new Promise((resolve, reject) => {
      ffmpeg(inPath)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate('128k') // Explicit bitrate
        .audioFrequency(44100) // Standard frequency
        .output(outPath)
        .on('start', (commandLine) => {
          console.log('FFmpeg command:', commandLine);
        })
        .on('progress', (progress) => {
          console.log('Processing: ' + progress.percent + '% done');
        })
        .on('end', () => {
          console.log('Conversion completed');
          resolve();
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          reject(err);
        })
        .run();
    });

    // Verify output file exists and has content
    if (!fs.existsSync(outPath)) {
      throw new Error("Conversion failed - output file not created");
    }

    const outputStats = fs.statSync(outPath);
    console.log('Output file size:', outputStats.size, 'bytes');
    
    if (outputStats.size === 0) {
      throw new Error("Conversion failed - output file is empty");
    }

    // Read & return MP3
    const mp3 = fs.readFileSync(outPath);
    
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": "attachment; filename=\"converted.mp3\"",
        "Content-Length": mp3.length.toString()
      },
      body: mp3.toString('base64'),
      isBase64Encoded: true,
    };
    
  } catch (err) {
    console.error('Handler error:', err);
    return { 
      statusCode: 500, 
      body: JSON.stringify({ 
        error: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
      }) 
    };
  } finally {
    // Cleanup temporary files
    try {
      if (inPath && fs.existsSync(inPath)) {
        fs.unlinkSync(inPath);
        console.log('Cleaned up input file');
      }
      if (outPath && fs.existsSync(outPath)) {
        fs.unlinkSync(outPath);
        console.log('Cleaned up output file');
      }
    } catch (cleanupErr) {
      console.error('Cleanup error:', cleanupErr);
    }
  }
};