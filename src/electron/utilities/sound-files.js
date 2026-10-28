const maxSoundBytes = 5 * 1024 * 1024;
const maxScanBytes = 4096;

// Bitrates in kbit/s, by MPEG version (1, or 2 for MPEG 2 and 2.5) and layer, indexed by the bitrate field of the header.
const mpegBitrates = {
    '1:1': [ 0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448 ],
    '1:2': [ 0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384 ],
    '1:3': [ 0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320 ],
    '2:1': [ 0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256 ],
    '2:2': [ 0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160 ],
    '2:3': [ 0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160 ],
};
// Sample rates by the version bits of the header: 3 is MPEG 1, 2 is MPEG 2 and 0 is MPEG 2.5.
const mpegSampleRates = { 3: [ 44100, 48000, 32000 ], 2: [ 22050, 24000, 16000 ], 0: [ 11025, 12000, 8000 ] };










/**
 * Returns the length of the ID3v2 tag at the start of the given data, or 0
 * when there is none.
 *
 * @param {Buffer} buffer The file data.
 * @returns {number} The length of the tag in bytes.
 */
function getId3Length( buffer ) {
    if ( buffer.length < 10 || buffer.toString( 'latin1', 0, 3 ) !== 'ID3' ) {
        return 0;
    }
    let size = ( ( buffer[ 6 ] & 0x7F ) << 21 ) | ( ( buffer[ 7 ] & 0x7F ) << 14 ) | ( ( buffer[ 8 ] & 0x7F ) << 7 ) | ( buffer[ 9 ] & 0x7F );
    let footer = ( buffer[ 5 ] & 0x10 ) !== 0 ? 10 : 0;
    return 10 + size + footer;
}










/**
 * Returns the length in bytes of the MPEG audio frame that starts at the given
 * offset, or 0 when there is no valid frame header there.  A header is not
 * valid with a reserved version, layer or sample rate, or with a bad or
 * free-format bitrate.
 *
 * @param {Buffer} data The file data.
 * @param {number} offset The offset of the frame header.
 * @returns {number} The length of the frame in bytes.
 */
function getMpegFrameLength( data, offset ) {
    let b1 = data[ offset + 1 ];
    let b2 = data[ offset + 2 ];
    if ( data[ offset ] !== 0xFF || ( b1 & 0xE0 ) !== 0xE0 || b2 === undefined ) {
        return 0;
    }

    let version = ( b1 >> 3 ) & 3;
    let layer = 4 - ( ( b1 >> 1 ) & 3 );
    let bitrate = mpegBitrates[ `${version === 3 ? 1 : 2}:${layer}` ]?.[ ( b2 >> 4 ) & 15 ];
    let sampleRate = mpegSampleRates[ version ]?.[ ( b2 >> 2 ) & 3 ];
    if ( !bitrate || !sampleRate ) {
        return 0;
    }

    let padding = ( b2 >> 1 ) & 1;
    if ( layer === 1 ) {
        return ( Math.floor( 12 * bitrate * 1000 / sampleRate ) + padding ) * 4;
    }
    return Math.floor( ( layer === 3 && version !== 3 ? 72 : 144 ) * bitrate * 1000 / sampleRate ) + padding;
}









/**
 * Returns true if the start of the given data matches the audio format that
 * the file extension claims.  An ID3v2 tag in front of the audio is skipped,
 * and the audio after it must match.
 *
 * @param {Buffer} buffer The file data.
 * @param {string} ext The lower case file extension, including the dot.
 * @returns {boolean} True if the data looks like the format of the extension.
 */
function hasSoundSignature( buffer, ext ) {
    if ( !buffer || buffer.length < 12 ) {
        return false;
    }

    // A tag that is cut off, or that leaves no audio after it, is not a sound.
    let id3Length = getId3Length( buffer );
    if ( id3Length >= buffer.length ) {
        return false;
    }
    let data = id3Length > 0 ? buffer.subarray( id3Length ) : buffer;
    let text = ( start, end ) => data.toString( 'latin1', start, end );
    let adts = data[ 0 ] === 0xFF && ( data[ 1 ] & 0xF6 ) === 0xF0;

    switch ( ext ) {
        case '.mp3': {
            // A frame header counts when the next frame starts exactly one frame length later, or when the
            // file ends right after the frame, optionally with a 128 byte ID3v1 tag behind it.
            let endsAt = ( position ) => position === data.length || ( position + 128 === data.length && data.toString( 'latin1', position, position + 3 ) === 'TAG' );
            for ( let i = 0; i < Math.min( data.length - 2, maxScanBytes ); i++ ) {
                let length = getMpegFrameLength( data, i );
                if ( length > 0 && ( endsAt( i + length ) || getMpegFrameLength( data, i + length ) > 0 ) ) {
                    return true;
                }
            }
            return false;
        }
        case '.ogg':
        case '.opus':
            return text( 0, 4 ) === 'OggS';
        case '.wav':
            return text( 0, 4 ) === 'RIFF' && text( 8, 12 ) === 'WAVE';
        case '.m4a':
        case '.aac':
            return text( 4, 8 ) === 'ftyp' || adts;
        case '.webm':
            return data[ 0 ] === 0x1A && data[ 1 ] === 0x45 && data[ 2 ] === 0xDF && data[ 3 ] === 0xA3;
        default:
            return false;
    }
}










/**
 * Checks the given sound before it is stored.
 *
 * @param {Buffer} buffer The file data.
 * @param {string} ext The lower case file extension, including the dot.
 * @returns {string|null} The reason the sound is rejected, or null when it is accepted.
 */
function checkSoundFile( buffer, ext ) {
    if ( buffer.length > maxSoundBytes ) {
        return `The sound is larger than ${maxSoundBytes / 1024 / 1024} MB.`;
    }
    if ( !hasSoundSignature( buffer, ext ) ) {
        return `The sound is not a valid ${ext} file.`;
    }
    return null;
}










module.exports = { maxSoundBytes, getId3Length, hasSoundSignature, checkSoundFile };
