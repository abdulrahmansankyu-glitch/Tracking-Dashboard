import { Global, Module } from '@nestjs/common';

import { ExportService } from './export/export.service';
import { ImportService } from './import/import.service';
import { NumberingService } from './numbering/numbering.service';
import { CryptoService } from './security/crypto.service';
import { StorageService } from './storage/storage.service';

/**
 * Infrastructure shared by every domain module. Global so feature modules do not each
 * have to re-import it.
 */
@Global()
@Module({
  providers: [ExportService, ImportService, NumberingService, CryptoService, StorageService],
  exports: [ExportService, ImportService, NumberingService, CryptoService, StorageService],
})
export class CommonModule {}
