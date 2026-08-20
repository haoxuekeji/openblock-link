/**
 * Fake esptool used by test/micropython-esptool-guidance.js.
 * The first argument selects the behaviour to replay.
 */
const mode = process.argv[2];

if (mode === 'sync-failure') {
    process.stdout.write('esptool.py v4.7.0\nSerial port /dev/ttyUSB0\nConnecting........_____....._____\n');
    process.stderr.write('\nA fatal error occurred: Failed to connect to ESP32: ' +
        'Timed out waiting for packet header\n');
    process.exit(2);
}

if (mode === 'other-failure') {
    process.stderr.write('A fatal error occurred: MD5 of file does not match data in flash!\n');
    process.exit(1);
}

process.stdout.write('Hash of data verified.\nLeaving...\nHard resetting via RTS pin...\n');
process.exit(0);
