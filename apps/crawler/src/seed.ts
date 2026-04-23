import { crawlQueue } from "./queue";

const seeds = ["EverySportsAnime"];

async function seed() {
  // Clean out any stale completed/failed jobs with these IDs from previous runs
  // so BullMQ doesn't silently skip re-adding them
  for (const username of seeds) {
    const jobId = `crawl_${username.toLowerCase()}`;
    const existing = await crawlQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      console.log(`  Found existing job ${jobId} in state: ${state}`);
      await existing.remove();
      console.log(`  Removed stale job ${jobId}`);
    }
  }

  for (const username of seeds) {
    await crawlQueue.add(
      "profile-crawl",
      { username: username.toLowerCase() },
      {
        jobId: `crawl_${username.toLowerCase()}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      },
    );
    console.log(`Queued: ${username}`);
  }

  console.log(`Seeded ${seeds.length} usernames into the queue`);
  await crawlQueue.close();
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
