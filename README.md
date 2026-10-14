# Sithu Laravel Offline

Durable browser queues and idempotent Laravel endpoints for offline form submissions.

The package supplies the generic pieces: account-scoped IndexedDB storage, serialized
cross-tab delivery, fresh-session/CSRF recovery, authenticated page caching, and
database receipts that make retries safe. Your application remains responsible for
validating its payload and returning the success response.

## Installation

After the package is registered on Packagist:

```bash
composer require sithu/laravel-offline
php artisan offline:install
php artisan migrate
```

Laravel package discovery registers the service provider automatically. For local
development before a release, add a Composer `path` repository pointing to this
directory.

The installation command publishes `config/offline.php`. List only authenticated pages
that are safe and useful to reopen offline. Add static asset paths needed by those pages.
Pages are cached only when their response carries the current account's owner header.

## Laravel routes

Apply `offline.page` to authenticated GET pages that may be cached:

```php
Route::get('/orders/create', CreateOrderController::class)
    ->middleware('offline.page');
```

Apply `offline.sync` as the outer middleware on a write route. Put application validation
after it so the validation and write run inside the same receipt transaction:

```php
Route::post('/orders', StoreOrderController::class)
    ->middleware(['offline.sync', ValidateOfflineOrder::class]);
```

An offline-aware controller must return JSON with `ok: true` only after the application
write has succeeded:

```php
return response()->json([
    'ok' => true,
    'resource_id' => $order->id,
]);
```

Redirects, error responses, exceptions, or JSON without `ok: true` do not create a
receipt. The package rolls back the surrounding transaction, and the browser retains
the operation for retry or review.

## Browser client

Load the package client from the named `offline.client` route, then create one client
per signed-in account:

```html
<script src="{{ route('offline.client') }}"></script>
<script>
const offline = new SithuOffline.Client({
    owner: @json(\Sithu\Offline\Identity::owner(request())),
    sessionUrl: @json(route('offline.session')),
});

await offline.enqueue({
    action: form.action,
    entries: [...new FormData(form)].map(([name, value]) => ({ name, value })),
    resource: 'order:new',
    snapshot: applicationSpecificRecoveryData,
});

offline.start();
</script>
```

The application adapter should disable its submit controls until IndexedDB opens, retain
entered values if storage fails, and clear a form only after `enqueue()` resolves. File
uploads require a separate adapter and are rejected by the generic middleware.

Register the authenticated service worker endpoint on HTTPS or localhost:

```js
navigator.serviceWorker.register('/sithu-offline-sw.js', { scope: '/' });
```

Send a `CACHE_PAGE` message after registration to prepare the current configured page.
See this repository's invoice adapter for a complete implementation including form
recovery, queued-edit ordering, export, manual retry, and legacy-draft review.

## Guarantees and limits

- Operation UUIDs are immutable and tied to the authenticated account.
- Application changes and their server receipt commit in one database transaction.
- A lost HTTP response can be retried without repeating the write.
- Only one browser tab can claim a queued operation at a time.
- A fresh CSRF token is fetched before every sync run and after HTTP 419.
- Cache Storage and IndexedDB remain browser/device storage; applications should provide
  export and recovery controls for valuable drafts.
- Background Sync is intentionally unnecessary. An open application tab retries with
  bounded backoff whenever connectivity returns.

## Testing

```bash
npm install
npm test
```

The application integration should separately test validation, stock or balance updates,
conflict detection, controller failure rollback, and duplicate retries.
