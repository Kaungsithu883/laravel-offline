@props([
    'form' => 'invoice-form',
    'editing' => false,
    'resource' => null,
    'version' => '',
    'resetOnQueue' => null,
])
@php
    $offlineInvoiceOptions = [
        'owner' => \Sithu\Offline\Identity::owner(request()),
        'sessionUrl' => route('offline.session'),
        'workerUrl' => route('offline.worker'),
        'formId' => ltrim($form, '#'),
        'editing' => filter_var($editing, FILTER_VALIDATE_BOOLEAN),
        'resource' => $resource,
        'version' => $version,
        'resetOnQueue' => is_null($resetOnQueue) ? !filter_var($editing, FILTER_VALIDATE_BOOLEAN) : filter_var($resetOnQueue, FILTER_VALIDATE_BOOLEAN),
    ];
@endphp
<span data-offline-invoice-config="{{ base64_encode(json_encode($offlineInvoiceOptions)) }}" hidden></span>
<script src="{{ route('offline.client') }}"></script>
<script src="{{ route('offline.invoice.client') }}"></script>
