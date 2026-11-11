#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const originalLoad = Module._load;
const realDiscord = require('discord.js');
class FakeClient extends EventEmitter {
  constructor() { super(); this.guilds = { cache: new Map() }; }
  login() { return Promise.resolve(); }
  destroy() {}
}
Module._load = function(request, parent, isMain) {
  if (request === 'discord.js') return { ...realDiscord, Client: FakeClient };
  return originalLoad.apply(this, arguments);
};
const bot = require('../bot/discord-bot');
const { alertSvg } = require('../bot/alert-image');
Module._load = originalLoad;
(async () => {
  const instance = bot.start({ ownerId:'owner', token:'test', siteUrl:'https://freef1-live.vercel.app', log:()=>{} });
  try {
    const logo = alertSvg({name:'Test Grand Prix',round:1},{name:'Race'},'live');
    assert(logo.includes('M2 17.5L7.5 6.5h5.2l-2 4h4.6l-1.6 3.2H8.9l-1.7 3.8H2z'));
    assert(logo.includes('M14.5 6.5H22l-1.7 3.4h-7.5l1.7-3.4z'));
    for (const state of ['start','live','end']) {
      let sent = [], deferred, reply;
      let resolveDone; const done = new Promise(resolve => { resolveDone = resolve; });
      const interaction = {
        isButton:()=>false, isChatInputCommand:()=>true, commandName:'test', user:{id:'owner'}, guild:{id:'123'},
        channel:{send:async payload=>{sent.push(payload);return {url:'https://discord.com/channels/test'};}},
        options:{getSubcommand:()=>state},
        deferReply:async value=>{deferred=value;}, editReply:async value=>{reply=value;resolveDone();},
      };
      instance.client.emit(realDiscord.Events.InteractionCreate, interaction);
      await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>reject(Error('command timed out')),5000))]);
      assert.equal(deferred.ephemeral,true); assert.equal(sent.length,1); assert.match(sent[0].content,/^\*\*TEST · /);
      assert.deepEqual(sent[0].allowedMentions,{parse:[]}); assert.equal(sent[0].embeds,undefined);
      assert.equal(sent[0].files[0].name,`freef1-test-${state}.png`);
      assert.equal(sent[0].files[0].attachment.subarray(1,4).toString(),'PNG');
      assert.equal(sent[0].components[0].toJSON().components[0].url,'https://freef1-live.vercel.app');
      assert.match(reply.content,/Test alert sent in this channel/);
    }
    let refused, sendCount=0; let doneResolve; const done = new Promise(r=>doneResolve=r);
    instance.client.emit(realDiscord.Events.InteractionCreate, {isButton:()=>false,isChatInputCommand:()=>true,commandName:'test',user:{id:'not-owner'},reply:async value=>{refused=value;doneResolve()},channel:{send:()=>sendCount++}});
    await done; assert.equal(refused.ephemeral,true); assert.match(refused.content,/Owner-only/); assert.equal(sendCount,0);
    console.log('Discord image test commands: three states, target channel, permissions and no pings passed');
  } finally { instance.stop(); }
})().catch(error=>{ console.error(error);process.exitCode=1; });
