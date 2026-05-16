'use strict';

const logger = require('../src/utils/logger');

describe('logger — Phase D0 validation', () => {

  test('logger has all required methods', () => {
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.phase).toBe('function');
  });

  test('logger.info does not throw', () => {
    expect(() => logger.info('test message')).not.toThrow();
  });

  test('logger.info with meta does not throw', () => {
    expect(() => logger.info('test with meta', { key: 'value', num: 42 })).not.toThrow();
  });

  test('logger.phase does not throw', () => {
    expect(() => logger.phase('D0', 'setup', 'Phase D0 started')).not.toThrow();
  });

  test('logger.error does not throw', () => {
    expect(() => logger.error('test error', { code: 500 })).not.toThrow();
  });
});
