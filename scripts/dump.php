<?php

/**
 * Reference implementation for the parser tests: let PHP itself read a language
 * file and print it as JSON. Used only by scripts/php-oracle.mjs — the linter
 * never executes locale files.
 */

if ($argc < 2) {
    fwrite(STDERR, "usage: php scripts/dump.php <file>\n");
    exit(2);
}

$data = include $argv[1];

echo json_encode(
    $data,
    JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
);
