<?php

namespace Sithu\Offline;

use Illuminate\Console\Command;

class InstallCommand extends Command
{
    protected $signature = 'offline:install {--invoice : Show the plug-and-play invoice integration steps}';
    protected $description = 'Publish offline configuration and show the remaining setup steps';

    public function handle(): int
    {
        $this->call('vendor:publish', ['--tag' => 'offline-config']);
        $this->info('Run php artisan migrate to create the durable receipt tables.');
        $this->line('Add offline.sync to write routes and offline.page to configured offline pages.');
        if ($this->option('invoice')) {
            $this->newLine();
            $this->info('Invoice bridge:');
            $this->line('1. Add offline.page to the invoice create/edit GET routes.');
            $this->line('2. Add offline.invoice as the first middleware on invoice store/update routes.');
            $this->line('3. Add <x-offline::invoice form="invoice-form" /> after each invoice form.');
            $this->line('4. List the invoice pages and their CSS/JS assets in config/offline.php.');
        }
        $this->line('See vendor/kaungsithu883/laravel-offline/README.md for the complete integration contract.');

        return self::SUCCESS;
    }
}
