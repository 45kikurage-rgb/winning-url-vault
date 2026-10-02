export function predictAssignmentCampaign(card, availableCampaigns) {
  const available = new Map((availableCampaigns || []).map(campaign => [campaign.campaign_id, campaign]));
  const previous = [...(card?.assignments || [])]
    .filter(assignment => available.has(assignment.campaign_id))
    .sort((left, right) => String(right.last_assigned_at || right.assigned_at || "")
      .localeCompare(String(left.last_assigned_at || left.assigned_at || "")))[0];
  return previous ? available.get(previous.campaign_id) : null;
}
