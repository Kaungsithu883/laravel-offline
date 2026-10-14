<?php

namespace Sithu\Offline\Middleware;

use Closure;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Sithu\Offline\Identity;

class Idempotent
{
    public function handle(Request $request, Closure $next)
    {
        $id = $request->header('X-Offline-Id');
        if (!$id) {
            return $next($request);
        }

        $owner = Identity::owner($request);
        abort_unless(Str::isUuid($id), 422, 'Invalid offline operation ID.');
        abort_unless(hash_equals($owner, (string) $request->header('X-Offline-Owner')), 403, 'Sign in as the owner of this draft.');
        abort_if(count($request->allFiles()) > 0, 422, 'File uploads need a separate offline adapter.');
        $payload = $request->except('_token');
        ksort($payload);
        $hash = hash('sha256', $request->method().'|'.$request->path().'|'.json_encode($payload));

        try {
            return DB::transaction(function () use ($request, $next, $id, $owner, $hash) {
                // Serialize offline writes. The lock and receipt use the SAME database
                // transaction as application changes; a crash rolls all three back.
                DB::table('offline_sync_locks')->insertOrIgnore(['name' => 'writes']);
                DB::table('offline_sync_locks')->where('name', 'writes')->lockForUpdate()->first();
                $receipt = DB::table('offline_receipts')->where('owner', $owner)->where('operation_id', $id)->first();
                if ($receipt) {
                    abort_unless(hash_equals($receipt->payload_hash, $hash), 409, 'This operation ID was already used with different data.');
                    return response()->json(json_decode($receipt->response, true), $receipt->status);
                }

                $response = $next($request);
                if (!$response instanceof JsonResponse || $response->getStatusCode() >= 300 || ($response->getData(true)['ok'] ?? false) !== true) {
                    // Never commit a redirect/error from an application handler.
                    throw new HttpResponseException($response instanceof JsonResponse && $response->getStatusCode() >= 400
                        ? $response : response()->json(['message' => 'The save was not acknowledged. The draft is retained.'], 502));
                }

                $body = $response->getData(true);
                $body['operation_id'] = $id;
                $response->setData($body);
                DB::table('offline_receipts')->insert([
                    'owner' => $owner, 'operation_id' => $id, 'payload_hash' => $hash,
                    'response' => $response->getContent(), 'status' => $response->getStatusCode(), 'created_at' => now(),
                ]);

                return $response;
            }, 3);
        } catch (HttpResponseException $exception) {
            return $exception->getResponse();
        }
    }
}
