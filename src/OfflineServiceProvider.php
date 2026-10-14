<?php

namespace Sithu\Offline;

use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Blade;
use Illuminate\Support\ServiceProvider;

class OfflineServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__.'/../config/offline.php', 'offline');
    }

    public function boot(): void
    {
        $this->loadMigrationsFrom(__DIR__.'/../database/migrations');
        $this->loadViewsFrom(__DIR__.'/../resources/views', 'offline');
        Blade::anonymousComponentPath(__DIR__.'/../resources/views/components', 'offline');
        $this->app['router']->aliasMiddleware('offline.sync', Middleware\Idempotent::class);
        $this->app['router']->aliasMiddleware('offline.page', Middleware\OfflinePage::class);
        $this->app['router']->aliasMiddleware('offline.invoice', Middleware\InvoiceForm::class);

        Route::get('/sithu-offline/client.js', [OfflineController::class, 'client'])->name('offline.client');
        Route::get('/sithu-offline/invoice.js', [OfflineController::class, 'invoiceClient'])->name('offline.invoice.client');
        Route::middleware(config('offline.middleware'))->group(function () {
            Route::get('/sithu-offline/session', [OfflineController::class, 'session'])->name('offline.session');
            Route::get('/sithu-offline-sw.js', [OfflineController::class, 'worker'])->name('offline.worker');
        });

        if ($this->app->runningInConsole()) {
            $this->publishes([__DIR__.'/../config/offline.php' => config_path('offline.php')], 'offline-config');
            $this->commands([InstallCommand::class]);
        }
    }
}
