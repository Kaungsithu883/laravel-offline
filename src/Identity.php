<?php

namespace Sithu\Offline;

use Illuminate\Http\Request;

class Identity
{
    public static function owner(Request $request): string
    {
        abort_unless($request->user(), 401);

        return hash_hmac('sha256', get_class($request->user()).':'.$request->user()->getAuthIdentifier(), (string) config('app.key'));
    }
}
