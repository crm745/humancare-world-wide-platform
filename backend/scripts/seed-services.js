// One-time migration: loads the old static service list into the real Service table.
// Safe to re-run — skips any slug that already exists.
const { prisma } = require('../src/db/prisma');
const SERVICES = require('../src/modules/services/services.data');

async function main() {
  for (let i = 0; i < SERVICES.length; i++) {
    const s = SERVICES[i];
    const existing = await prisma.service.findUnique({ where: { slug: s.slug } });
    if (existing) {
      console.log(`skip (already exists): ${s.slug}`);
      continue;
    }
    await prisma.service.create({
      data: {
        slug: s.slug,
        name: s.name,
        subtitle: s.subtitle,
        description: s.description,
        provides: s.provides,
        sortOrder: i,
      },
    });
    console.log(`created: ${s.slug}`);
  }
  console.log('Done.');
}

main().finally(() => prisma.$disconnect());
