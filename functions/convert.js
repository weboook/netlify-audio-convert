const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

exports.handler = async (event) => {
  try {
    const { url } = JSON.parse(event.body || '{}');
    if (!url) throw new Error("No URL provided");

    const inPath  = path.join(os.tmpdir(), 'in.m4a');
    const outPath = path.join(os.tmpdir(), 'out.mp3');

    // Download M4A
    const resp = await axios.get(url, { responseType: 'stream' });
    await new Promise((res, rej) =>
      resp.data.pipe(fs.createWriteStream(inPath))
              .on('finish', res).on('error', rej)
    );

    // Convert to MP3
    await new Promise((res, rej) => {
      ffmpeg(inPath)
        .noVideo()
        .audioCodec('libmp3lame')
        .output(outPath)
        .on('end',  res)
        .on('error', rej)
        .run();
    });

    // Read & return MP3
    const mp3 = fs.readFileSync(outPath);
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": "attachment; filename=\"converted.mp3\"",
      },
      body: mp3.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
