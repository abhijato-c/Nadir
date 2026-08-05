import {defineConfig} from 'vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
    base : '/',
    plugins : [cesium()],
    worker: {format: 'es'},
    build: {
        rollupOptions: {
            onwarn(warning, warn) {
                if (warning.message && warning.message.includes('externalized for browser compatibility')) {
                    return;
                }
                warn(warning);
            }
        }
    }
});