# M4A to MP3 Converter API

A serverless function that converts M4A audio files to MP3 format using FFmpeg. Simply provide a URL to an M4A file and get back a converted MP3.

## Features

- **Fast Conversion**: Uses FFmpeg for high-quality audio conversion
- **Serverless**: Runs on AWS Lambda or similar platforms
- **Simple API**: Single endpoint with URL parameter
- **Direct Download**: Returns MP3 file ready for download

## Usage

### Basic Request

```bash
curl -X POST "https://your-api-endpoint.com/convert" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/audio.m4a"}' \
  --output converted.mp3
```

### Request Format

**Method:** `POST`

**Headers:**
- `Content-Type: application/json`

**Body:**
```json
{
  "url": "https://example.com/your-audio-file.m4a"
}
```

### Response

**Success (200):**
- Returns the converted MP3 file as a binary download
- `Content-Type: audio/mpeg`
- `Content-Disposition: attachment; filename="converted.mp3"`

**Error (500):**
```json
{
  "error": "Error message description"
}
```

## Examples

### Convert a remote M4A file
```bash
curl -X POST "https://your-api-endpoint.com/convert" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/podcast.m4a"}' \
  --output my-podcast.mp3
```

### Using with JavaScript fetch
```javascript
const response = await fetch('https://your-api-endpoint.com/convert', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    url: 'https://example.com/audio.m4a'
  })
});

if (response.ok) {
  const blob = await response.blob();
  // Handle the MP3 blob
} else {
  const error = await response.json();
  console.error('Conversion failed:', error.error);
}
```

## Deployment

### AWS Lambda

1. Install dependencies:
```bash
npm install axios fluent-ffmpeg ffmpeg-static
```

2. Deploy using your preferred method (Serverless Framework, AWS SAM, etc.)

3. Set up API Gateway to trigger the Lambda function

### Environment Requirements

- Node.js runtime
- Access to `/tmp` directory for temporary file storage
- Sufficient memory allocation (recommended: 512MB+)
- Timeout setting (recommended: 30+ seconds for large files)

## Error Handling

The API handles several error conditions:

- **Missing URL**: Returns 500 with "No URL provided"
- **Download Failure**: Network issues accessing the source M4A file
- **Conversion Failure**: FFmpeg processing errors
- **File System Errors**: Temporary file read/write issues

## Limitations

- Source file must be accessible via HTTP/HTTPS
- File size limited by serverless platform constraints
- Temporary storage cleared after each request
- No authentication or rate limiting included

## Dependencies

- `axios`: HTTP client for downloading files
- `fluent-ffmpeg`: FFmpeg wrapper for Node.js
- `ffmpeg-static`: Static FFmpeg binary
- Built-in Node.js modules: `fs`, `path`, `os`

## Contributing

Feel free to submit issues and enhancement requests!

## License

MIT License - see LICENSE file for detailss