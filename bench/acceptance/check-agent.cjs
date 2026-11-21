'use strict';
const assert=require('node:assert/strict');const {execFileSync}=require('node:child_process');
const q="select json_build_object('points',count(p.*),'series',count(distinct s.id)) from metric_points p join metric_series s on s.id=p.series_id where s.host='ci-systemd-acceptance'";
const counts=JSON.parse(execFileSync('psql',[process.env.DATABASE_URL,'-XAt','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8'}));
assert.ok(Number(counts.points)>0&&Number(counts.series)>0,'systemd agent must store metrics');
const expected=execFileSync('sha256sum',[process.env.PRODUCT_ROOT+'/agent/dist/monitoring-agent-linux-amd64'],{encoding:'utf8'}).split(' ')[0];
const actual=execFileSync('sha256sum',['/opt/monitoring-agent/bin/monitoring-agent'],{encoding:'utf8'}).split(' ')[0];assert.equal(actual,expected);
console.log(JSON.stringify({kind:'systemd-lifecycle',stored:counts,installed_sha256:actual,reboot_tested:false}));
