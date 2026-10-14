<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('offline_sync_locks', function (Blueprint $table) {
            $table->string('name', 80)->primary();
        });
        Schema::create('offline_receipts', function (Blueprint $table) {
            $table->id();
            $table->string('owner', 64);
            $table->uuid('operation_id');
            $table->string('payload_hash', 64);
            $table->longText('response');
            $table->unsignedSmallInteger('status');
            $table->timestamp('created_at');
            $table->unique(['owner', 'operation_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('offline_receipts');
        Schema::dropIfExists('offline_sync_locks');
    }
};
