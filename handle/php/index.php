<?php

header('Content-Type: application/json');

// Configuration
$endpoint = 'https://your-api-endpoint.netlify.app/.netlify/functions/convert';
$bearerToken = 'your-secret-token-here'; // Change this to your actual token

$payload = json_encode([
    'url' => 'https.doomain.com/your-file.m4a'
]);

// Initialize cURL
$ch = curl_init($endpoint);

curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $payload,
    CURLOPT_HTTPHEADER     => [
        'Content-Type: application/json',
        'Authorization: Bearer ' . $bearerToken,
    ],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HEADER         => true,
    CURLOPT_TIMEOUT        => 60,
]);

// Execute
$response = curl_exec($ch);

if (curl_errno($ch)) {
    $error = curl_error($ch);
    curl_close($ch);
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => 'cURL error: ' . $error
    ]);
    exit;
}

$httpCode   = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
curl_close($ch);

$headers = substr($response, 0, $headerSize);
$body    = substr($response, $headerSize);

// Check HTTP code
if ($httpCode !== 200) {
    http_response_code($httpCode);
    echo json_encode([
        'success' => false,
        'error' => "API returned HTTP $httpCode",
        'response_headers' => $headers,
        'response_body' => $body
    ]);
    exit;
}

// Parse response headers to check content type
$contentType = '';
$headerLines = explode("\r\n", $headers);
foreach ($headerLines as $line) {
    if (stripos($line, 'content-type:') === 0) {
        $contentType = trim(substr($line, 13));
        break;
    }
}

// Check if response is JSON (error) or binary (success)
if (stripos($contentType, 'application/json') !== false) {
    // It's a JSON error response
    $decoded = json_decode($body, true);
    if (json_last_error() === JSON_ERROR_NONE) {
        http_response_code(400);
        echo json_encode([
            'success' => false,
            'error' => $decoded['error'] ?? 'Unknown error from API',
            'api_response' => $decoded
        ]);
        exit;
    }
}

// Check if response is MP3 binary data
if (stripos($contentType, 'audio/mpeg') !== false) {
    // Direct binary MP3 data
    $mp3Data = $body;
} else {
    // Try to parse as JSON with base64 body
    $decoded = json_decode($body, true);
    if (json_last_error() === JSON_ERROR_NONE && isset($decoded['body'])) {
        // Netlify function format with base64 body
        $mp3Data = base64_decode($decoded['body']);
    } else {
        // Fallback: try to decode entire body as base64
        $mp3Data = base64_decode($body);
        
        // Validate it's actually MP3 data
        if (strlen($mp3Data) < 100 || (substr($mp3Data, 0, 3) !== 'ID3' && (ord($mp3Data[0]) !== 0xFF || (ord($mp3Data[1]) & 0xE0) !== 0xE0))) {
            http_response_code(500);
            echo json_encode([
                'success' => false,
                'error' => 'Invalid MP3 data received from API',
                'debug' => [
                    'content_type' => $contentType,
                    'body_start' => substr($body, 0, 100),
                    'is_json' => json_last_error() === JSON_ERROR_NONE
                ]
            ]);
            exit;
        }
    }
}

// Validate MP3 data
if (empty($mp3Data)) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => 'No MP3 data received from API'
    ]);
    exit;
}

// Additional MP3 validation
$mp3Start = substr($mp3Data, 0, 10);
$isValidMP3 = (substr($mp3Data, 0, 3) === 'ID3') || // ID3 tag
              (strlen($mp3Data) > 2 && ord($mp3Data[0]) === 0xFF && (ord($mp3Data[1]) & 0xE0) === 0xE0); // MP3 frame header

if (!$isValidMP3) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => 'Received data is not valid MP3 format',
        'debug' => [
            'data_length' => strlen($mp3Data),
            'first_bytes' => bin2hex($mp3Start)
        ]
    ]);
    exit;
}

// Save binary MP3 data to file
$filePath = __DIR__ . '/result.mp3';
$bytesWritten = file_put_contents($filePath, $mp3Data);

if ($bytesWritten === false) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => 'Failed to write MP3 file'
    ]);
    exit;
}

// File size
$fileSize = filesize($filePath);

// Return JSON success
echo json_encode([
    'success'       => true,
    'file'          => 'result.mp3',
    'file_size'     => $fileSize,
    'bytes_written' => $bytesWritten,
    'message'       => 'MP3 successfully saved',
    'content_type'  => $contentType,
    'mp3_valid'     => $isValidMP3
]);

?>