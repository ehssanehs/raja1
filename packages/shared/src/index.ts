/**
 * @raja/shared — framework-free domain primitives used by every application.
 *
 * This package must not import any other workspace package (it is the bottom of the dependency
 * graph) and must stay free of Node-only APIs so the web app can use it.
 */

export * from './money';
export * from './time';
export * from './constants';
export * from './errors';
export * from './ids';
export * from './permissions';
export * from './result';
export * from './fingerprint';
export * from './validation';
export * from './i18n';
