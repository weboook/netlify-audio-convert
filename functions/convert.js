const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { spawn } = require('child_process');

// Get FFmpeg paths - either from included binaries or fallback paths
function getFFmpegPaths() {
  const possiblePaths = [
    // First try included binaries
    path.join(__dirname, '..', 'bin', 'ffmpeg'),
    path.join(__dirname, 'bin', 'ffmpeg'),
    path.join(process.cwd(), 'bin', 'ffmpeg'),
    
    // Then try common system paths
    '/opt/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    'ffmpeg' // PATH fallback
  ];

  const probePaths = [
    path.join(__dirname, '..', 'bin', 'ffprobe'),
    path.join(__dirname, 'bin', 'ffprobe'),
    path.join(process.cwd(), 'bin', 'ffprobe'),
    '/opt/bin/ffprobe',
    '/usr/bin/ffprobe', 
    '/usr/local/bin/ffprobe',
    'ffprobe'
  ];

  let ffmpegPath = null;
  let ffprobePath = null;

  // Find FFmpeg
  for (const testPath of possiblePaths) {
    try {
      if (fs.existsSync(testPath) && fs.statSync(testPath).isFile()) {
        console.log('Found FFmpeg at:', testPath);
        ffmpegPath = testPath;
        break;
      }
    } catch (e) {
      // Continue to next path
    }
  }

  // Find FFprobe
  for (const testPath of probePaths) {
    try {
      if (fs.existsSync(testPath) && fs.statSync(testPath).isFile()) {
        console.log('Found FFprobe at:', testPath);
        ffprobePath = testPath;
        break;
      }
    } catch (e) {
      // Continue to next path
    }
  }

  if (!ffmpegPath) {
    throw new Error('FFmpeg binary not found. Please ensure the static binary is included.');
  }
  
  if (!ffprobePath) {
    throw new Error('FFprobe binary not found. Please ensure the static binary is included.');
  }

  return { ffmpegPath, ffprobePath };
}

// Test FFmpeg installation
async function testFFmpeg(ffmpegPath) {
  return new Promise((resolve, reject) => {
    const testProcess = spawn(ffmpegPath, ['-version'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';
    testProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    testProcess.on('close', (code) => {
      if (code === 0 && output.includes('ffmpeg version')) {
        console.log('FFmpeg test successful');
        resolve();
      } else {
        reject(new Error(`FFmpeg test failed with code ${code}`));
      }
    });

    testProcess.on('error', (err) => {
      reject(new Error(`FFmpeg test error: ${err.message}`));
    });

    // Timeout after 3 seconds
    setTimeout(() => {
      testProcess.kill('SIGTERM');
      reject(new Error('FFmpeg test timeout'));
    }, 3000);
  });
}

// Convert using direct spawn with ultra-fast settings
function convertWithFFmpeg(ffmpegPath, inputPath, outputPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', inputPath,
      '-acodec', 'libmp3lame',
      '-ab', '96k',              // Lower bitrate for speed
      '-ar', '22050',            // Lower sample rate for speed  
      '-ac', '1',                // Mono for speed
      '-preset', 'ultrafast',
      '-f', 'mp3',
      '-y', // Overwrite output file
      outputPath
    ];
    
    console.log('Running ultra-fast FFmpeg conversion...');
    
    const ffmpegProcess = spawn(ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let stderr = '';
    
    ffmpegProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    const timeout = setTimeout(() => {
      ffmpegProcess.kill('SIGKILL');
      reject(new Error('FFmpeg conversion timeout'));
    }, timeoutMs);
    
    ffmpegProcess.on('close', (code) => {
      clearTimeout(timeout);
      
      if (code === 0) {
        console.log('FFmpeg conversion successful');
        resolve();
      } else {
        console.error('FFmpeg failed with code:', code);
        reject(new Error(`FFmpeg conversion failed with exit code ${code}`));
      }
    });
    
    ffmpegProcess.on('error', (err) => {
      clearTimeout(timeout);
      console.error('FFmpeg spawn error:', err);
      reject(new Error(`FFmpeg spawn failed: ${err.message}`));
    });
  });
}

exports.handler = async (event) => {
  let inPath, outPath;
  const startTime = Date.now();
  const MAX_PROCESSING_TIME = 8000; // Reduced to 8 seconds to work within 10s limit
  
  try {
    console.log('Function started, looking for FFmpeg...');
    
    // Get FFmpeg paths quickly
    const { ffmpegPath, ffprobePath } = getFFmpegPaths();
    console.log('FFmpeg found, parsing request...');

    const { url } = JSON.parse(event.body || '{}');
    if (!url) throw new Error("No URL provided");

    const timestamp = Date.now();
    inPath = path.join(os.tmpdir(), `in_${timestamp}.m4a`);
    outPath = path.join(os.tmpdir(), `out_${timestamp}.mp3`);

    console.log('Starting download for:', url);
    
    // Download the file with aggressive timeout
    const downloadStart = Date.now();
    
    const resp = await axios.get(url, { 
      responseType: 'stream',
      timeout: 4000, // Reduced to 4 seconds
      maxContentLength: 10 * 1024 * 1024, // Reduced to 10MB max
      maxRedirects: 2,
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
      }, 3000); // Reduced to 3 seconds
      
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
    
    if (remainingTime < 2000) {
      throw new Error("Insufficient time remaining for conversion");
    }

    console.log(`Starting conversion with ${remainingTime}ms remaining...`);
    
    // Convert the file with remaining time
    await convertWithFFmpeg(ffmpegPath, inPath, outPath, remainingTime - 1000);

    // Verify output
    if (!fs.existsSync(outPath)) {
      throw new Error("Conversion did not create output file");
    }

    const outputStats = fs.statSync(outPath);
    if (outputStats.size === 0) {
      throw new Error("Conversion created empty output file");
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
      errorMessage = "File too large or conversion taking too long. Try a smaller file (max 10MB).";
      statusCode = 504;
    } else if (err.message.includes('ENOTFOUND') || err.message.includes('network')) {
      errorMessage = "Could not download the source file. Check the URL and ensure it's accessible.";
      statusCode = 400;
    } else if (err.message.includes('FFmpeg') || err.message.includes('ffmpeg')) {
      errorMessage = "Audio conversion failed. The file may be corrupted or in an unsupported format.";
      statusCode = 422;
    } else if (err.message.includes('binary not found')) {
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
        }
      } catch (e) {
        // Silent cleanup failure
      }
    }
  }
};