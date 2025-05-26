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

    const timestamp = Date.now();
    inPath = path.join(os.tmpdir(), `in_${timestamp}.m4a`);
    outPath = path.join(os.tmpdir(), `out_${timestamp}.mp3`);

    console.log('Starting conversion for:', url);
    
    // Download the file
    const downloadStart = Date.now();
    const resp = await axios.get(url, { 
      responseType: 'stream',
      timeout: 15000,
      maxContentLength: 50 * 1024 * 1024
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
    });

    // Verify input file
    const inputStats = fs.statSync(inPath);
    if (inputStats.size === 0) {
      throw new Error("Downloaded file is empty");
    }

    console.log('Starting FFmpeg conversion...');
    const conversionStart = Date.now();
    
    // More explicit FFmpeg conversion
    await new Promise((resolve, reject) => {
      ffmpeg(inPath)
        .inputFormat('m4a')           // Explicitly set input format
        .audioCodec('libmp3lame')     // MP3 codec
        .noVideo()                    // Remove any video streams
        .audioBitrate('128k')         // Standard bitrate
        .audioFrequency(44100)        // Standard frequency
        .audioChannels(2)             // Stereo
        .format('mp3')                // Explicitly set output format
        .outputOptions([
          '-id3v2_version', '3',      // ID3v2.3 tags (more compatible)
          '-write_id3v1', '1',        // Also write ID3v1 tags
          '-map', '0:a:0'             // Map only the first audio stream
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
          const conversionTime = Date.now() - conversionStart;
          console.log(`Conversion completed in ${conversionTime}ms`);
          resolve();
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err.message);
          reject(new Error(`FFmpeg conversion failed: ${err.message}`));
        })
        .run();
    });

    // Verify output file exists and has content
    if (!fs.existsSync(outPath)) {
      throw new Error("FFmpeg did not create output file");
    }

    const outputStats = fs.statSync(outPath);
    if (outputStats.size === 0) {
      throw new Error("FFmpeg created empty output file");
    }

    // Read a few bytes to verify it's actually MP3
    const buffer = fs.readFileSync(outPath);
    const firstBytes = buffer.slice(0, 3);
    
    // Check for MP3 signatures
    const isMP3 = (
      (firstBytes[0] === 0xFF && (firstBytes[1] & 0xE0) === 0xE0) || // MP3 frame header
      (firstBytes.toString() === 'ID3')                               // ID3 tag
    );

    if (!isMP3) {
      console.error('Output file does not appear to be valid MP3');
      console.error('First 10 bytes:', buffer.slice(0, 10));
      throw new Error("Conversion produced invalid MP3 file");
    }

    const totalTime = Date.now() - startTime;
    console.log(`Total processing: ${totalTime}ms, output: ${outputStats.size} bytes`);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": "attachment; filename=\"converted.mp3\"",
        "Content-Length": buffer.length.toString(),
        "X-Processing-Time": totalTime.toString()
      },
      body: buffer.toString('base64'),
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
    // Cleanup
    try {
      if (inPath && fs.existsSync(inPath)) fs.unlinkSync(inPath);
      if (outPath && fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch (e) {
      console.error('Cleanup error:', e.message);
    }
  }
};