import { config } from '../config.ts';
import { ApiClient } from './client.ts';

export const api = new ApiClient(config.apiUrl);
