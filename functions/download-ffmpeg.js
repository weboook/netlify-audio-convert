const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('Downloading FFmpeg static binary...');

const binDir = path.join(__dirname, 'bin');
if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

const ffmpegUrl = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';
const downloadPath = path.join(binDir, 'ffmpeg-static.tar.xz');
const ffmpegPath = path.join(binDir, 'ffmpeg');
const ffprobePath = path.join(binDir, 'ffprobe');

// Check if already downloaded
if (fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath)) {
  console.log('FFmpeg binaries already exist, skipping download.');
  return;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Handle redirect
        return downloadFile(response.headers.location, dest)
          .then(resolve)
          .catch(reject);
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed with status: ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        resolve();
      });
      
      file.on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function main() {
  try {
    // Download FFmpeg
    console.log('Downloading FFmpeg...');
    await downloadFile(ffmpegUrl, downloadPath);
    console.log('Download completed');
    
    // Extract
    console.log('Extracting...');
    execSync(`cd ${binDir} && tar -xf ffmpeg-static.tar.xz --strip-components=1`, { stdio: 'inherit' });
    
    // Make executable
    if (fs.existsSync(ffmpegPath)) {
      fs.chmodSync(ffmpegPath, '755');
      console.log('FFmpeg binary ready');
    }
    
    if (fs.existsSync(ffprobePath)) {
      fs.chmodSync(ffprobePath, '755');
      console.log('FFprobe binary ready');
    }
    
    // Cleanup
    if (fs.existsSync(downloadPath)) {
      fs.unlinkSync(downloadPath);
    }
    
    console.log('FFmpeg setup complete!');
    
  } catch (error) {
    console.warn('FFmpeg download failed:', error.message);
    console.warn('This may cause issues in production. Consider manually adding FFmpeg binaries.');
  }
}

main();