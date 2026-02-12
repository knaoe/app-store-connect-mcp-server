import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { basename } from 'path';
import { AppStoreConnectClient } from '../services/index.js';
import {
  ScreenshotDisplayType,
  ListScreenshotSetsResponse,
  ScreenshotSetResponse,
  CreateScreenshotSetRequest,
  ListAppScreenshotsResponse,
  AppScreenshotResponse,
  ReserveScreenshotUploadRequest,
  CommitScreenshotUploadRequest,
  ReorderScreenshotsRequest,
} from '../types/index.js';
import { validateRequired } from '../utils/index.js';

export class ScreenshotHandlers {
  constructor(private client: AppStoreConnectClient) {}

  async listScreenshotSets(args: {
    localizationId: string;
  }): Promise<ListScreenshotSetsResponse> {
    validateRequired(args, ['localizationId']);

    return this.client.get<ListScreenshotSetsResponse>(
      `/appStoreVersionLocalizations/${args.localizationId}/appScreenshotSets`
    );
  }

  async createScreenshotSet(args: {
    localizationId: string;
    screenshotDisplayType: ScreenshotDisplayType;
  }): Promise<ScreenshotSetResponse> {
    validateRequired(args, ['localizationId', 'screenshotDisplayType']);

    const requestData: CreateScreenshotSetRequest = {
      data: {
        type: 'appScreenshotSets',
        attributes: {
          screenshotDisplayType: args.screenshotDisplayType,
        },
        relationships: {
          appStoreVersionLocalization: {
            data: {
              type: 'appStoreVersionLocalizations',
              id: args.localizationId,
            },
          },
        },
      },
    };

    return this.client.post<ScreenshotSetResponse>(
      '/appScreenshotSets',
      requestData
    );
  }

  async listScreenshots(args: {
    screenshotSetId: string;
  }): Promise<ListAppScreenshotsResponse> {
    validateRequired(args, ['screenshotSetId']);

    return this.client.get<ListAppScreenshotsResponse>(
      `/appScreenshotSets/${args.screenshotSetId}/appScreenshots`
    );
  }

  async uploadScreenshot(args: {
    screenshotSetId: string;
    filePath: string;
  }): Promise<AppScreenshotResponse> {
    validateRequired(args, ['screenshotSetId', 'filePath']);

    // Step 1: Read file and compute MD5
    const fileBuffer = await readFile(args.filePath);
    const md5Checksum = createHash('md5').update(fileBuffer).digest('hex');
    const fileName = basename(args.filePath);

    // Step 2: Reserve upload
    const reserveRequest: ReserveScreenshotUploadRequest = {
      data: {
        type: 'appScreenshots',
        attributes: {
          fileName,
          fileSize: fileBuffer.length,
        },
        relationships: {
          appScreenshotSet: {
            data: {
              type: 'appScreenshotSets',
              id: args.screenshotSetId,
            },
          },
        },
      },
    };

    const reservation = await this.client.post<AppScreenshotResponse>(
      '/appScreenshots',
      reserveRequest
    );

    const screenshotId = reservation.data.id;
    const uploadOperations = reservation.data.attributes.uploadOperations;

    if (!uploadOperations || uploadOperations.length === 0) {
      throw new Error('No upload operations returned from reservation');
    }

    // Step 3: Upload binary chunks via presigned URLs
    for (const op of uploadOperations) {
      const chunk = fileBuffer.subarray(op.offset, op.offset + op.length);
      const headers: Record<string, string> = {};
      for (const h of op.requestHeaders) {
        headers[h.name] = h.value;
      }
      await this.client.uploadBinaryToUrl(op.url, chunk, headers);
    }

    // Step 4: Commit upload
    const commitRequest: CommitScreenshotUploadRequest = {
      data: {
        type: 'appScreenshots',
        id: screenshotId,
        attributes: {
          sourceFileChecksum: md5Checksum,
          uploaded: true,
        },
      },
    };

    return this.client.patch<AppScreenshotResponse>(
      `/appScreenshots/${screenshotId}`,
      commitRequest
    );
  }

  async deleteScreenshot(args: {
    screenshotId: string;
  }): Promise<void> {
    validateRequired(args, ['screenshotId']);

    await this.client.delete(`/appScreenshots/${args.screenshotId}`);
  }

  async deleteScreenshotSet(args: {
    screenshotSetId: string;
  }): Promise<void> {
    validateRequired(args, ['screenshotSetId']);

    await this.client.delete(`/appScreenshotSets/${args.screenshotSetId}`);
  }

  async reorderScreenshots(args: {
    screenshotSetId: string;
    screenshotIds: string[];
  }): Promise<void> {
    validateRequired(args, ['screenshotSetId', 'screenshotIds']);

    const requestData: ReorderScreenshotsRequest = {
      data: {
        type: 'appScreenshotSets',
        id: args.screenshotSetId,
        relationships: {
          appScreenshots: {
            data: args.screenshotIds.map((id) => ({
              type: 'appScreenshots' as const,
              id,
            })),
          },
        },
      },
    };

    await this.client.patch(
      `/appScreenshotSets/${args.screenshotSetId}/relationships/appScreenshots`,
      requestData
    );
  }
}
