const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { spawn } = require('child_process');

// Try to locate FFmpeg binary
function getFFmpegPath() {
  const possiblePaths = [
    '/opt/bin/ffmpeg',           // Lambda layer
    '/usr/bin/ffmpeg',           // System install  
    '/usr/local/bin/ffmpeg',     // Manual install
    'ffmpeg'                     // PATH fallback
  ];
  
  // First try ffmpeg-static
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      console.log('Using ffmpeg-static:', ffmpegStatic);
      return ffmpegStatic;
    }
  } catch (e) {
    console.log('ffmpeg-static not available:', e.message);
  }
  
  // Try system paths
  for (const testPath of possiblePaths) {
    try {
      require('child_process').execSync(`${testPath} -version`, { 
        stdio: 'pipe',
        timeout: 3000 
      });
      console.log('Found FFmpeg at:', testPath);
      return testPath;
    } catch (e) {
      // Continue to next path
    }
  }
  
  throw new Error('FFmpeg not found. Please ensure ffmpeg-static is properly installed.');
}

// Convert using direct spawn for better control
function convertWithFFmpeg(inputPath, outputPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFFmpegPath();
    
    const args = [
      '-i', inputPath,
      '-acodec', 'libmp3lame',
      '-ab', '128k',
      '-ar', '44100',
      '-ac', '2',
      '-f', 'mp3',
      '-y', // Overwrite output file
      outputPath
    ];
    
    console.log('Running FFmpeg:', ffmpegPath, args.join(' '));
    
    const ffmpegProcess = spawn(ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    ffmpegProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    ffmpegProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      // FFmpeg outputs progress to stderr
      if (data.toString().includes('time=')) {
        console.log('FFmpeg progress:', data.toString().trim());
      }
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
        console.error('FFmpeg stderr:', stderr);
        reject(new Error(`FFmpeg conversion failed with exit code ${code}: ${stderr}`));
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
  const MAX_PROCESSING_TIME = 22000; // 22 seconds max to leave buffer
  
  try {
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
      maxRedirects: 3
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
    
    // Convert the file
    await convertWithFFmpeg(inPath, outPath, remainingTime - 2000);

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
    } else if (err.message.includes('FFmpeg not found') || err.message.includes('spawn')) {
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