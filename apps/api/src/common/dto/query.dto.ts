import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min,
} from 'class-validator';
import { EXPORT_FORMATS, FILTER_OPERATORS, type FilterCondition } from '@intoto/shared';

/**
 * The list-query contract shared by every collection endpoint.
 * Filters arrive JSON-encoded in the query string, which keeps arbitrarily complex
 * filtering expressible in a GET (and therefore cacheable and shareable as a URL).
 */
export class QueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 25, maximum: 500 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500)
  pageSize = 25;

  @ApiPropertyOptional({ description: 'Free-text search across the resource\'s searchable fields' })
  @IsOptional() @IsString() @MaxLength(200)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(100)
  sortBy?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional() @IsIn(['asc', 'desc'])
  sortDir: 'asc' | 'desc' = 'desc';

  @ApiPropertyOptional({
    description:
      'JSON array of conditions, e.g. [{"field":"gstRate","operator":"eq","value":12}]',
    type: String,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return undefined;
    if (Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(String(value));
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      // Rejected by the @IsArray check below rather than throwing here, so the client
      // gets a field-level validation error instead of a raw parse failure.
      return 'invalid';
    }
  })
  @IsArray()
  filters?: FilterCondition[];

  @ApiPropertyOptional({ default: false })
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean()
  includeArchived = false;

  @ApiPropertyOptional({ default: false })
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean()
  onlyArchived = false;

  @ApiPropertyOptional()
  @IsOptional() @IsString()
  shopId?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional() @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional() @IsDateString()
  dateTo?: string;
}

export class ExportQueryDto extends QueryDto {
  @ApiPropertyOptional({ enum: EXPORT_FORMATS, default: 'xlsx' })
  @IsOptional() @IsIn([...EXPORT_FORMATS])
  format: (typeof EXPORT_FORMATS)[number] = 'xlsx';

  @ApiPropertyOptional({ description: 'Comma-separated column keys to include' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').map((s) => s.trim()) : value))
  @IsArray()
  columns?: string[];

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(200)
  title?: string;
}

export class ArchiveDto {
  @ApiPropertyOptional({ description: 'Recorded in the audit trail' })
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

/** Available so clients can build a filter UI without hardcoding the operator list. */
export const SUPPORTED_FILTER_OPERATORS = FILTER_OPERATORS;
