'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { adaptBundle } = require('./mirasim-claude.cjs');

const fixture = `
const descriptor={'baseUrlEnv':'ANTHROPIC_BASE_URL','authTokenEnv':'ANTHROPIC_AUTH_TOKEN'};
const credentialless=!options['accountToken']&&!!config['relayToken']&&feature()&&!!agent(options['agent'])&&!native(settings(),options['agent']);
const useRelay=feature()&&(agent(options['agent'])?.['carriesOrdinaryTraffic']||credentialless)&&config['relayToken']&&(config['enabled']||credentialless);
result={descriptor,useRelay,managed:!!descriptor.authTokenEnv&&!!config.relayToken&&(credentialless||config.enabled),
interceptor:{'failoverAgent':options['agent'],'relayCredentialless':()=>credentialless,'directAuth':()=>options.accountToken}};
`;

test('uses managed cloud routing regardless of local login or Desktop mode', () => {
  for (const enabled of [false, true]) {
    for (const accountToken of [null, 'native-token']) {
      const context = {
        options: { agent: 'claude', accountToken },
        config: { relayToken: 'mirasim-token', enabled },
        feature: () => true,
        agent: () => ({ carriesOrdinaryTraffic: true }),
        native: () => { throw new Error('must not consult native credentials'); }
      };
      vm.runInNewContext(adaptBundle(fixture), context);
      const { result } = context;
      assert.equal(result.useRelay, true);
      assert.equal(result.managed, true);
      assert.equal(result.interceptor.relayCredentialless(), true);
      assert.equal(result.interceptor.relayCloudOnly(), true);
      context.config.enabled = !enabled;
      context.config.relayToken = 'renewed-token';
      assert.equal(result.interceptor.relayCloudOnly(), true);
    }
  }
});

test('refuses startup without a usable relay even when a native token exists', () => {
  for (const missing of ['token', 'feature', 'agent']) {
    const context = {
      options: { agent: 'claude', accountToken: 'native-token' },
      config: { relayToken: missing === 'token' ? '' : 'mirasim-token', enabled: true },
      feature: () => missing !== 'feature',
      agent: () => missing === 'agent' ? null : { carriesOrdinaryTraffic: true }
    };
    assert.throws(() => vm.runInNewContext(adaptBundle(fixture), context), /需要可用的 Mirasim 云端登录/);
    assert.equal(context.result, undefined);
  }
});

test('refuses changed or ambiguous bundle structures', () => {
  for (const source of [fixture + fixture, adaptBundle(fixture),
    fixture.replace("'accountToken'", "'newAccountField'"),
    fixture.replace("'relayCredentialless'", "'newRoutingField'"),
    fixture.replace("'authTokenEnv'", "'newTokenField'"),
    fixture.replace("'baseUrlEnv'", "'newBaseUrlField'")]) {
    assert.throws(() => adaptBundle(source), /云路由结构已变化/);
  }
});
