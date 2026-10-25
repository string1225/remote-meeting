// Opt-in real hardware acceptance. No camera images are saved.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { localStack, mediaLaunchOptions, remotePage, connectRemote, startCameras, setView } from './browser-fixture.mjs';
const stack=await localStack({hardware:true}), browser=await chromium.launch(mediaLaunchOptions);
try {
 const remote=await remotePage(browser,stack.errors); await connectRemote(remote,stack.url,stack.password);
 assert.equal(stack.local.hostStatus().capturing,false); assert.equal(stack.local.hostStatus().microphone,false);
 await remote.locator('#host-microphone-toggle').click(); await stack.host.waitForFunction(()=>hostDiagnostics().microphone&&!hostDiagnostics().capturing);
 await startCameras(remote);
 await remote.waitForFunction(()=>meetingStats().some(p=>p.receivedVideo>60&&p.receivedAudio>0&&p.transport==='p2p'),null,{timeout:45000});
 const before=await remote.evaluate(()=>({frames:document.querySelector('#host-video').getVideoPlaybackQuality().totalVideoFrames,time:performance.now()}));
 await remote.waitForFunction(time=>performance.now()-time>8000,before.time);
 const after=await remote.evaluate(()=>({frames:document.querySelector('#host-video').getVideoPlaybackQuality().totalVideoFrames,time:performance.now(),width:document.querySelector('#host-video').videoWidth,height:document.querySelector('#host-video').videoHeight,stats:meetingStats()}));
 assert.equal(after.width,1920);assert.equal(after.height,1080);
 await remote.locator('#camera-toggle').click();await remote.locator('#microphone-toggle').click();
 await stack.host.waitForFunction(()=>hostMediaStats().some(p=>p.receivedVideo>5&&p.receivedAudio>0&&p.transport==='p2p'));
 assert.deepEqual(await stack.host.evaluate(()=>testMediaRequests),[]);
 await setView(remote,0,2,0.25);await stack.host.waitForFunction(()=>hostDiagnostics().view.zoom===2);
 console.log(JSON.stringify({output:stack.local.hostStatus().output,cameras:stack.local.hostStatus().cameras,encoder:stack.local.hostStatus().virtualCamera,decodedFps:Math.round((after.frames-before.frames)*1000/(after.time-before.time)),media:after.stats}));
 await stack.host.locator('#view-cameras').click();await stack.host.locator('#local-camera-toggle').click();
 await stack.host.waitForFunction(()=>hostDiagnostics().virtualCamera.state==='stopped');assert.equal(stack.local.hostStatus().microphone,true);
 const context=await stack.hostBrowser.newContext({permissions:['camera']});const receiver=await context.newPage();await receiver.goto(stack.url);
 const released=await receiver.evaluate(async()=>{
  const devices=await navigator.mediaDevices.enumerateDevices(),result=[];
  for(const pattern of [/PC Camera/i,/Surface Camera Front/i]){
   const d=devices.find(d=>d.kind==='videoinput'&&pattern.test(d.label));assertDevice(d);
   const stream=await navigator.mediaDevices.getUserMedia({video:{deviceId:{exact:d.deviceId},width:{ideal:640,max:640},height:{ideal:480,max:480}},audio:false});
   result.push(stream.getVideoTracks()[0].readyState);stream.getTracks().forEach(t=>t.stop());
  }return result;
  function assertDevice(d){if(!d)throw Error('Original camera missing');}
 });assert.deepEqual(released,['live','live']);await context.close();assert.deepEqual(stack.errors,[]);
 console.log('PASS: manual backend USB/Surface/WASAPI capture, 1080p P2P H264/Opus, browser zero-capture, reverse video/audio, shared controls and independent physical-device release.');
} catch(error){console.error(stack.local.hostStatus());throw error;}
finally{await browser.close();await stack.close();}
