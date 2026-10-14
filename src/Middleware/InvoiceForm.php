<?php

namespace Sithu\Offline\Middleware;

use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;

class InvoiceForm
{
    public function __construct(private readonly Idempotent $idempotent)
    {
    }

    public function handle(Request $request, Closure $next)
    {
        if (!$request->header('X-Offline-Id')) {
            return $next($request);
        }

        return $this->idempotent->handle($request, function (Request $request) use ($next) {
            $response = $next($request);
            if ($response instanceof JsonResponse) {
                return $response;
            }

            if (!$response instanceof RedirectResponse) {
                return $response;
            }

            $newFlash = $request->hasSession() ? (array) $request->session()->get('_flash.new', []) : [];
            $errorKeys = (array) config('offline.invoice.error_flash_keys', ['errors', 'error', 'danger']);
            $failedKey = collect($errorKeys)->first(fn (string $key) => in_array($key, $newFlash, true));
            if ($failedKey) {
                $value = $request->session()->get($failedKey);
                $message = is_string($value) && $value !== '' ? $value : 'The invoice was not saved. The offline draft was retained.';

                return response()->json(['ok' => false, 'message' => $message], $failedKey === 'errors' ? 422 : 500);
            }

            return response()->json([
                'ok' => true,
                'redirect_url' => $response->getTargetUrl(),
            ]);
        });
    }
}
