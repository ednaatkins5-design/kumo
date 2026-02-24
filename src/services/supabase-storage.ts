import { createClient } from '@supabase/supabase-js';
import { ENV } from '../config/env';
import { logger } from '../utils/logger';

export class SupabaseStorageService {
    private supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_KEY);
    private bucket = ENV.SUPABASE_STORAGE_BUCKET;

    async uploadFile(filePath: string, remotePath: string): Promise<string> {
        try {
            const fileBuffer = require('fs').readFileSync(filePath);
            const fileName = remotePath.split('/').pop();
            
            const { data, error } = await this.supabase.storage
                .from(this.bucket)
                .upload(remotePath, fileBuffer, {
                    contentType: this.getContentType(fileName || ''),
                    upsert: true
                });

            if (error) {
                logger.error({ error, filePath, remotePath }, 'Failed to upload file to Supabase');
                throw error;
            }

            logger.info({ filePath, remotePath }, 'File uploaded to Supabase');
            
            const { data: publicData } = this.supabase.storage
                .from(this.bucket)
                .getPublicUrl(remotePath);
            
            return publicData.publicUrl;
        } catch (err) {
            logger.error({ err, filePath, remotePath }, 'Error uploading file to Supabase');
            throw err;
        }
    }

    async downloadFile(remotePath: string, localPath: string): Promise<void> {
        try {
            const { data, error } = await this.supabase.storage
                .from(this.bucket)
                .download(remotePath);

            if (error) {
                logger.error({ error, remotePath, localPath }, 'Failed to download from Supabase');
                throw error;
            }

            require('fs').writeFileSync(localPath, data);
            logger.info({ remotePath, localPath }, 'File downloaded from Supabase');
        } catch (err) {
            logger.error({ err, remotePath, localPath }, 'Error downloading from Supabase');
            throw err;
        }
    }

    async deleteFile(remotePath: string): Promise<void> {
        try {
            const { error } = await this.supabase.storage
                .from(this.bucket)
                .remove([remotePath]);

            if (error) {
                logger.error({ error, remotePath }, 'Failed to delete from Supabase');
                throw error;
            }

            logger.info({ remotePath }, 'File deleted from Supabase');
        } catch (err) {
            logger.error({ err, remotePath }, 'Error deleting from Supabase');
            throw err;
        }
    }

    getPublicUrl(remotePath: string): string {
        const { data } = this.supabase.storage
            .from(this.bucket)
            .getPublicUrl(remotePath);
        
        return data.publicUrl;
    }

    async listFiles(folder: string): Promise<string[]> {
        try {
            const { data, error } = await this.supabase.storage
                .from(this.bucket)
                .list(folder);

            if (error) {
                logger.error({ error, folder }, 'Failed to list files in Supabase');
                return [];
            }

            return data.map(f => `${folder}/${f.name}`);
        } catch (err) {
            logger.error({ err, folder }, 'Error listing files in Supabase');
            return [];
        }
    }

    private getContentType(fileName: string): string {
        const ext = fileName.split('.').pop()?.toLowerCase();
        const types: Record<string, string> = {
            'pdf': 'application/pdf',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'png': 'image/png',
            'gif': 'image/gif',
            'doc': 'application/msword',
            'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'xls': 'application/vnd.ms-excel',
            'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        };
        return types[ext || ''] || 'application/octet-stream';
    }
}

export const supabaseStorage = new SupabaseStorageService();
