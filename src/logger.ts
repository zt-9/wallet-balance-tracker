import { consola } from 'consola';

// Configure consola
consola.level = process.env.LOG_LEVEL ? parseInt(process.env.LOG_LEVEL) : 3; // Default to info level

// Export the configured logger
export default consola;
