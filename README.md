# Sithu Laravel Offline

Durable browser queues and idempotent Laravel endpoints for offline form submissions,
with a plug-and-play bridge for ordinary invoice create and edit forms.

The package supplies the generic pieces: account-scoped IndexedDB storage, serialized
cross-tab delivery, fresh-session/CSRF recovery, authenticated page caching, and
database receipts that make retries safe. Your application remains responsible for
validating its payload and returning the success response.

## Installation

After the package is registered on Packagist:

```bash
composer require kaungsithu883/laravel-offline
php artisan offline:install --invoice
php artisan migrate
```

Laravel package discovery registers the service provider automatically. For local
development before a release, add a Composer `path` repository pointing to this
directory.

The installation command publishes `config/offline.php`. List only authenticated pages
that are safe and useful to reopen offline. Add static asset paths needed by those pages.
Pages are cached only when their response carries the current account's owner header.

## Plug-and-play invoice forms

Invoice data is stored in account-scoped **IndexedDB**, not PHP session storage,
`sessionStorage`, or `localStorage`. The queued request survives refreshes and browser
restarts. When the application becomes reachable, the exact same operation ID is sent
to Laravel and the server receipt prevents a retry from creating a second invoice.

Add `offline.page` to the create/edit pages and `offline.invoice` as the outer middleware
on the existing store/update routes:

```php
Route::get('/invoices/create', [InvoiceController::class, 'create'])
    ->middleware('offline.page');
Route::get('/invoices/{invoice}/edit', [InvoiceController::class, 'edit'])
    ->middleware('offline.page');

Route::post('/invoices', [InvoiceController::class, 'store'])
    ->middleware(['offline.invoice', ValidateInvoice::class]);
Route::post('/invoices/{invoice}', [InvoiceController::class, 'update'])
    ->middleware(['offline.invoice', ValidateInvoice::class]);
```

The existing controller may keep returning a normal success redirect. The bridge turns
that redirect into an idempotent JSON receipt only for an offline request. A redirect
that newly flashes `errors`, `error`, or `danger` is treated as a failure and the entire
database transaction is rolled back. Controllers that return JSON must return
`{"ok": true}` on success.

Give the form an ID and add the component after it:

```blade
<form id="invoice-form" method="POST" action="{{ isset($invoice)
    ? url('/invoices/'.$invoice->id)
    : url('/invoices') }}">
    @csrf
    {{-- the application's existing invoice fields --}}
</form>

<x-offline::invoice
    form="invoice-form"
    :editing="isset($invoice)"
    :resource="isset($invoice) ? 'invoice:'.$invoice->id : null"
    :version="isset($invoice) ? $invoiceVersion : ''"
/>
```

Normal submit buttons work automatically. For an existing `type="button"` save button,
add `data-offline-save`. A button may set the invoice status before capture:

```blade
<button type="button" data-offline-save data-offline-status-value="invoice">Save</button>
<button type="button" data-offline-save data-offline-status-value="invoice_suspend">Suspend</button>
```

Repeating item or payment rows can be reconstructed after a refresh by marking the
container, rows, and existing add-row button:

```blade
<tbody data-offline-repeat="lines">
    <tr data-offline-row>...</tr>
</tbody>
<button type="button" data-offline-add-row="lines">Add item</button>
```

Add `data-offline-include-disabled` to a disabled input whose value must be submitted.
File inputs are intentionally rejected; attachments need a separate upload workflow.
The bridge emits `offline:invoice-restored`, `offline:invoice-queued`, and
`offline:invoice-synced` DOM events so calculations or application UI can react without
forking the package script.

List the create/edit URL prefixes and every CSS/JavaScript asset required to render those
pages in `config/offline.php`. A page must be opened once online over HTTPS (or localhost)
before it can be refreshed offline.

The package safely delivers the existing form to the existing controller. The controller
remains responsible for normal invoice validation, authorization, stock locking, unit
conversion, and payment rules. Put custom validation middleware after `offline.invoice`
so it runs inside the same transaction as the operation receipt.

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
