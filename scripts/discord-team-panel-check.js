'use strict';
const assert=require('node:assert/strict');
const { _test:{TEAMS,teamPanelPayload,mapTeamRoles,changeTeamRole} }=require('../bot/discord-bot');
const {gridSvg}=require('../bot/grid-image');
(async()=>{
 const svg=gridSvg(TEAMS,true); assert(svg.includes('TEAM ROLES')); assert(svg.includes('Choose one team')); assert(!svg.includes('Charles Leclerc'));assert(svg.includes('Ferrari'));
 const payload=teamPanelPayload(); const buttons=payload.components.flatMap(r=>r.toJSON().components);assert.equal(buttons.length,11);assert.equal(new Set(buttons.map(b=>b.custom_id)).size,11);assert.deepEqual(payload.allowedMentions,{parse:[]});
 const all=TEAMS.map((t,i)=>({id:String(i+1),name:t.name==='Red Bull'?'Redbull':t.name,managed:false}));
 const roles=mapTeamRoles(all); assert(roles.every(Boolean));
 const fromDiscordCache=mapTeamRoles(new Map(all.map(role=>[role.id,role])).values()); assert(fromDiscordCache.every(Boolean),'Discord Collection iterator must work for every team');assert.equal(roles[3].name,'Redbull');assert.equal(mapTeamRoles([...all,{...all[3],id:'duplicate'}])[3],null);assert.equal(mapTeamRoles(all.slice(1))[0],null);
 const held=new Set(['1','3','driver-role','unrelated']);const operations=[];const member={roles:{cache:{has:id=>held.has(id)},remove:async id=>{operations.push('remove '+id);held.delete(id)},add:async id=>{assert.equal([...held].filter(x=>roles.some(r=>r.id===x)).length,0);operations.push('add '+id);held.add(id)}}};
 assert.equal(await changeTeamRole(member,roles,3),true);assert.deepEqual([...held].sort(),['4','driver-role','unrelated']);assert.deepEqual(operations,['remove 1','remove 3','add 4']);
 assert.equal(await changeTeamRole(member,roles,3),false);assert.deepEqual([...held].sort(),['driver-role','unrelated']);
 await assert.rejects(()=>changeTeamRole(member,[null,...roles.slice(1)],3));
 console.log('Team panel: matching, ambiguity, artwork, buttons and exclusive team toggles passed');
})().catch(e=>{console.error(e);process.exit(1)});
