<?php

namespace Sithu\Offline;

use Illuminate\Console\Command;

class InstallCommand extends Command
{
    protected $signature = 'offline:install';
    protected $description = 'Publish offline configuration and show the remaining setup steps';

    public function handle(): int
    {
        $this->call('vendor:publish', ['--tag' => 'offline-config']);
        $this->info('Run php artisan migrate to create the durable receipt tables.');
        $this->line('Add offline.sync to write routes and offline.page to configured offline pages.');
        $this->line('See vendor/sithu/laravel-offline/README.md for the response contract and browser adapter.');

        return self::SUCCESS;
    }
}
