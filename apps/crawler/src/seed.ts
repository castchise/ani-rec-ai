import { crawlQueue } from "./index";

const seeds = ["Xinil", "seanboyy", "kineta"]; // well-known MAL power users

for (const username of seeds) {
  await crawlQueue.add(
    "profile-crawl",
    { username },
    {
      jobId: `crawl:${username}`,
    },
  );
}
console.log(`Seeded ${seeds.length} usernames`);
process.exit(0);
