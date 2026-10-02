import test from 'node:test';
import assert from 'node:assert/strict';
import {predictAssignmentCampaign} from '../public/assignment-prediction.js';

test('利用可能なキャンペーンのうち直近の仕分け先を予測する', () => {
  const campaigns = [
    {campaign_id:'a',campaign_name:'A'},
    {campaign_id:'b',campaign_name:'B'}
  ];
  const card = {assignments:[
    {campaign_id:'a',last_assigned_at:'2026-10-01T00:00:00Z'},
    {campaign_id:'b',last_assigned_at:'2026-10-02T00:00:00Z'}
  ]};
  assert.equal(predictAssignmentCampaign(card,campaigns).campaign_id,'b');
});

test('終了済みなど利用できない過去の仕分け先は予測しない', () => {
  const card = {assignments:[{campaign_id:'closed',last_assigned_at:'2026-10-02T00:00:00Z'}]};
  assert.equal(predictAssignmentCampaign(card,[{campaign_id:'active'}]),null);
});
