<?php

namespace Sithu\Offline\Middleware;

use Closure;
use Illuminate\Http\Request;
use Sithu\Offline\Identity;

class OfflinePage
{
    public function handle(Request $request, Closure $next)
    {
        $response = $next($request);
        $response->headers->set('X-Offline-Owner', Identity::owner($request));
        $response->headers->set('Cache-Control', 'no-store, private');

        return $response;
    }
}
