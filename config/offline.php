<?php

return [
    'middleware' => ['web', 'auth'],
    // Only these application pages may be cached, and only with an owner header.
    'pages' => [],
    'assets' => [],
    'invoice' => [
        // A controller that redirects after saving can be used without modification.
        // Redirects carrying any of these newly-flashed keys are treated as failures.
        'error_flash_keys' => ['errors', 'error', 'danger'],
    ],
];
