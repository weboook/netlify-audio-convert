const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { spawn } = require('child_process');

// Debug logger that collects messages for response
class DebugLogger {
  constructor() {
    this.messages = [];
  }
  
  log(message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = data ? `${timestamp}: ${message} ${JSON.stringify(data)}` : `${timestamp}: ${message}`;
    this.messages.push(logEntry);
    console.log(logEntry); // Still log to console for Netlify logs
  }
  
  error(message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = data ? `${timestamp}: ERROR - ${message} ${JSON.stringify(data)}` : `${timestamp}: ERROR - ${message}`;
    this.messages.push(logEntry);
    console.error(logEntry);
  }
  
  getMessages() {
    return this.messages;
  }
}

// Get FFmpeg paths - either from included binaries or fallback paths
function getFFmpegPaths(logger) {
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
        logger.log('Found FFmpeg at:', testPath);
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
        logger.log('Found FFprobe at:', testPath);
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

// Check available encoders in FFmpeg
async function checkAvailableEncoders(ffmpegPath, logger) {
  return new Promise((resolve) => {
    const encoderProcess = spawn(ffmpegPath, ['-encoders'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let stdout = '';
    
    encoderProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    const timeout = setTimeout(() => {
      encoderProcess.kill('SIGKILL');
      resolve({ hasLibmp3lame: false, hasMp3: false, availableEncoders: 'timeout' });
    }, 2000);
    
    encoderProcess.on('close', (code) => {
      clearTimeout(timeout);
      
      const hasLibmp3lame = stdout.includes('libmp3lame');
      const hasMp3 = stdout.includes(' mp3 ') || stdout.includes('mp3float');
      
      logger.log('Available encoders check:', { hasLibmp3lame, hasMp3 });
      
      resolve({ hasLibmp3lame, hasMp3, availableEncoders: stdout.substring(0, 500) });
    });
    
    encoderProcess.on('error', (err) => {
      clearTimeout(timeout);
      logger.error('Encoder check failed:', err.message);
      resolve({ hasLibmp3lame: false, hasMp3: false, availableEncoders: 'error' });
    });
  });
}
async function probeAudioFile(ffprobePath, inputPath, logger) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      inputPath
    ];
    
    logger.log('Probing audio file for metadata...');
    
    const probeProcess = spawn(ffprobePath, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    probeProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    probeProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    const timeout = setTimeout(() => {
      probeProcess.kill('SIGKILL');
      reject(new Error('FFprobe timeout'));
    }, 5000);
    
    probeProcess.on('close', (code) => {
      clearTimeout(timeout);
      
      if (code === 0) {
        try {
          const metadata = JSON.parse(stdout);
          logger.log('Audio probe successful:', {
            format: metadata.format?.format_name,
            duration: metadata.format?.duration,
            streams: metadata.streams?.length,
            codec: metadata.streams?.[0]?.codec_name
          });
          resolve(metadata);
        } catch (parseErr) {
          reject(new Error(`Failed to parse probe output: ${parseErr.message}`));
        }
      } else {
        logger.error('FFprobe failed with code:', code);
        logger.error('FFprobe stderr:', stderr.substring(0, 300));
        reject(new Error(`Audio file probe failed with exit code ${code}. File may be corrupted or unsupported.`));
      }
    });
    
    probeProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`FFprobe spawn failed: ${err.message}`));
    });
  });
}

// Convert using direct spawn with iOS M4A specific strategies
function convertWithFFmpeg(ffmpegPath, inputPath, outputPath, timeoutMs, metadata, logger, encoderInfo) {
  return new Promise((resolve, reject) => {
    // Detect if this is likely an iOS M4A file
    const isIosM4a = metadata && (
      metadata.format?.format_name?.includes('mov,mp4,m4a') ||
      metadata.streams?.[0]?.codec_name === 'aac' ||
      metadata.format?.tags?.['com.apple.finalcutstudio.media.uuid']
    );
    
    logger.log('File analysis:', {
      isIosM4a,
      format: metadata?.format?.format_name,
      codec: metadata?.streams?.[0]?.codec_name,
      hasLibmp3lame: encoderInfo?.hasLibmp3lame,
      hasMp3: encoderInfo?.hasMp3
    });

    // Strategy selection with built-in encoder fallbacks (no libmp3lame dependency)
    const strategies = [
      // Strategy 1: Built-in MP3 encoder (most compatible)
      {
        name: 'builtin-mp3',
        args: [
          '-i', inputPath,
          '-c:a', 'mp3',            // Use built-in mp3 encoder
          '-b:a', '64k',
          '-ar', '16000',
          '-ac', '1',
          '-threads', '0',
          '-f', 'mp3',
          '-y',
          outputPath
        ]
      },
      // Strategy 2: Copy audio stream if already compatible
      {
        name: 'stream-copy',
        args: [
          '-i', inputPath,
          '-c:a', 'copy',           // Try direct copy first
          '-f', 'mp3',
          '-y',
          outputPath
        ]
      },
      // Strategy 3: Force MP3 with different approach
      {
        name: 'force-mp3',
        args: [
          '-f', 'mp4',              // Force MP4 container read
          '-i', inputPath,
          '-vn',                    // No video
          '-c:a', 'mp3',
          '-b:a', '96k',
          '-ar', '22050',
          '-ac', '1',
          '-threads', '0',
          '-f', 'mp3',
          '-y',
          outputPath
        ]
      },
      // Strategy 4: libmp3lame (original - try last)
      {
        name: 'libmp3lame-fallback',
        args: [
          '-i', inputPath,
          '-acodec', 'libmp3lame',
          '-ab', '64k',
          '-ar', '16000',
          '-ac', '1',
          '-preset', 'ultrafast',
          '-threads', '0',
          '-f', 'mp3',
          '-y',
          outputPath
        ]
      },
      // Strategy 5: Raw AAC to MP3 conversion
      {
        name: 'aac-decode',
        args: [
          '-i', inputPath,
          '-map', '0:a:0',          // Map first audio stream
          '-c:a', 'mp3',
          '-b:a', '96k',
          '-ar', '22050',
          '-ac', '1',
          '-strict', 'experimental',
          '-f', 'mp3',
          '-y',
          outputPath
        ]
      }
    ];

    // Filter strategies based on available encoders
    let availableStrategies = strategies;
    
    if (!encoderInfo?.hasLibmp3lame) {
      logger.log('libmp3lame not available, filtering strategies');
      availableStrategies = strategies.filter(s => !s.name.includes('libmp3lame'));
    }
    
    if (!encoderInfo?.hasMp3 && !encoderInfo?.hasLibmp3lame) {
      logger.error('No MP3 encoders available, this will likely fail');
    }
    // Reorder strategies if iOS M4A detected
    if (isIosM4a) {
      logger.log('iOS M4A detected, prioritizing iOS-specific strategies');
      // Move aac-decode strategy to front for iOS files
      const aacStrategy = availableStrategies.find(s => s.name === 'aac-decode');
      if (aacStrategy) {
        availableStrategies.splice(availableStrategies.indexOf(aacStrategy), 1);
        availableStrategies.unshift(aacStrategy);
      }
    }

    logger.log('Using strategies:', availableStrategies.map(s => s.name));

    let currentStrategy = 0;
    const attemptedStrategies = [];

    function tryConversion() {
      if (currentStrategy >= availableStrategies.length) {
        logger.error('All conversion strategies failed', { attemptedStrategies });
        reject(new Error(`All conversion strategies failed. Attempted: ${attemptedStrategies.join(', ')}`));
        return;
      }

      const strategy = availableStrategies[currentStrategy];
      logger.log(`Trying conversion strategy: ${strategy.name} (${currentStrategy + 1}/${availableStrategies.length})`);
      attemptedStrategies.push(strategy.name);
      
      const ffmpegProcess = spawn(ffmpegPath, strategy.args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      let stderr = '';
      let stdout = '';
      
      ffmpegProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      ffmpegProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      const timeout = setTimeout(() => {
        ffmpegProcess.kill('SIGKILL');
        logger.error(`Strategy ${strategy.name} timed out`);
        currentStrategy++;
        setTimeout(tryConversion, 100);
      }, timeoutMs);
      
      ffmpegProcess.on('close', (code) => {
        clearTimeout(timeout);
        
        if (code === 0) {
          logger.log(`FFmpeg conversion successful with strategy: ${strategy.name}`);
          resolve();
        } else {
          logger.error(`Strategy ${strategy.name} failed with exit code: ${code}`);
          if (stderr) {
            logger.error(`Strategy ${strategy.name} stderr:`, stderr.substring(0, 300));
          }
          
          // Try next strategy
          currentStrategy++;
          setTimeout(tryConversion, 100);
        }
      });
      
      ffmpegProcess.on('error', (err) => {
        clearTimeout(timeout);
        logger.error(`Strategy ${strategy.name} spawn error:`, err.message);
        
        // Try next strategy
        currentStrategy++;
        setTimeout(tryConversion, 100);
      });
    }

    tryConversion();
  });
}

// Validate bearer token
function validateBearerToken(event) {
  const authHeader = event.headers.authorization || event.headers.Authorization;
  
  if (!authHeader) {
    throw new Error("Missing Authorization header");
  }
  
  if (!authHeader.startsWith('Bearer ')) {
    throw new Error("Invalid authorization format. Use 'Bearer <token>'");
  }
  
  const token = authHeader.substring(7); // Remove 'Bearer ' prefix
  const validToken = process.env.API_TOKEN;
  
  if (!validToken) {
    throw new Error("Server configuration error: API token not set");
  }
  
  if (token !== validToken) {
    throw new Error("Invalid authentication token");
  }
  
  return true;
}

exports.handler = async (event) => {
  const logger = new DebugLogger();
  let inPath, outPath;
  const startTime = Date.now();
  const MAX_PROCESSING_TIME = 9000; // Reduced to 9 seconds to stay under Netlify's 10s limit
  
  try {
    logger.log('Function started, validating authentication...');
    
    // Validate bearer token first
    validateBearerToken(event);
    logger.log('Authentication successful, looking for FFmpeg...');
    
    // Get FFmpeg paths quickly
    const { ffmpegPath, ffprobePath } = getFFmpegPaths(logger);
    logger.log('FFmpeg found, parsing request...');

    const { url } = JSON.parse(event.body || '{}');
    if (!url) throw new Error("No URL provided");

    const timestamp = Date.now();
    inPath = path.join(os.tmpdir(), `in_${timestamp}.m4a`);
    outPath = path.join(os.tmpdir(), `out_${timestamp}.mp3`);

    logger.log('Starting download for:', url);
    
    // Download the file with increased limits
    const downloadStart = Date.now();
    
    const resp = await axios.get(url, { 
      responseType: 'stream',
      timeout: 4000, // Reduced to 4 seconds
      maxContentLength: 25 * 1024 * 1024, // Keep 25MB but with faster processing
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
        logger.log(`Download completed in ${downloadTime}ms, size: ${fileSize} bytes`);
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

    // Check available encoders first
    const encoderInfo = await checkAvailableEncoders(ffmpegPath, logger);
    
    // Probe the audio file to validate format and get metadata
    let metadata = null;
    try {
      metadata = await probeAudioFile(ffprobePath, inPath, logger);
    } catch (probeErr) {
      logger.error('Audio probe failed, proceeding with conversion:', probeErr.message);
      // Continue with conversion even if probe fails
    }

    // Check remaining time - need at least 2 seconds for conversion
    const timeElapsed = Date.now() - startTime;
    const remainingTime = MAX_PROCESSING_TIME - timeElapsed;
    
    if (remainingTime < 2000) {
      throw new Error("Insufficient time remaining for conversion. File may be too large for processing within time limits.");
    }

    logger.log(`Starting conversion with ${remainingTime}ms remaining...`);
    
    // Convert the file with remaining time and metadata (save 500ms for cleanup)
    await convertWithFFmpeg(ffmpegPath, inPath, outPath, remainingTime - 500, metadata, logger, encoderInfo);

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
    logger.log(`Total processing: ${totalTime}ms, output: ${outputStats.size} bytes`);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": "attachment; filename=\"converted.mp3\"",
        "Content-Length": buffer.length.toString(),
        "X-Processing-Time": totalTime.toString(),
        "X-Debug-Messages": JSON.stringify(logger.getMessages()),
        "Cache-Control": "no-cache"
      },
      body: buffer.toString('base64'),
      isBase64Encoded: true,
    };
    
  } catch (err) {
    const totalTime = Date.now() - startTime;
    logger.error(`Error after ${totalTime}ms:`, err.message);
    
    // Enhanced error messages
    let errorMessage = err.message;
    let statusCode = 500;
    
    if (err.message.includes('timeout') || err.message.includes('Timeout') || err.message.includes('Timedout')) {
      errorMessage = "Processing timeout. File too large or complex for 10-second limit. Try a smaller file (max 25MB) or shorter audio.";
      statusCode = 504;
    } else if (err.message.includes('ENOTFOUND') || err.message.includes('network')) {
      errorMessage = "Could not download the source file. Check the URL and ensure it's accessible.";
      statusCode = 400;
    } else if (err.message.includes('FFmpeg') || err.message.includes('ffmpeg') || err.message.includes('conversion strategies failed')) {
      errorMessage = "Audio conversion failed after trying multiple strategies. The iOS M4A file may have encoding issues or be corrupted. Try re-recording the audio.";
      statusCode = 422;
    } else if (err.message.includes('binary not found')) {
      errorMessage = "Audio conversion service temporarily unavailable. Please try again later.";
      statusCode = 503;
    } else if (err.message.includes('Authorization') || err.message.includes('authentication') || err.message.includes('Invalid')) {
      errorMessage = "Authentication failed. Please provide a valid bearer token.";
      statusCode = 401;
    } else if (err.message.includes('probe failed') || err.message.includes('corrupted')) {
      errorMessage = "iOS M4A file appears to be corrupted or uses an unsupported encoding. Please try re-recording or using a different app.";
      statusCode = 422;
    }
    
    return { 
      statusCode: statusCode,
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Messages": JSON.stringify(logger.getMessages())
      },
      body: JSON.stringify({ 
        error: errorMessage,
        processingTime: totalTime,
        debug: err.message,
        debugMessages: logger.getMessages() // Include debug messages in error response
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