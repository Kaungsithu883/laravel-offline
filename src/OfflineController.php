<?php

namespace Sithu\Offline;

use Illuminate\Http\Request;

class OfflineController
{
    public function session(Request $request)
    {
        return response()->json(['owner' => Identity::owner($request), 'token' => csrf_token()])
            ->header('Cache-Control', 'no-store, private');
    }

    public function client()
    {
        return response(file_get_contents(__DIR__.'/../resources/offline.js'))
            ->header('Content-Type', 'application/javascript')->header('Cache-Control', 'no-cache');
    }

    public function worker(Request $request)
    {
        $settings = json_encode([
            'owner' => Identity::owner($request),
            'pages' => config('offline.pages', []),
            'assets' => array_merge([route('offline.client')], config('offline.assets', [])),
        ], JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);

        return response('const settings = '.$settings.";\n".file_get_contents(__DIR__.'/../resources/worker.js'))
            ->header('Content-Type', 'application/javascript')->header('Cache-Control', 'no-store')
            ->header('Service-Worker-Allowed', '/');
    }
}
