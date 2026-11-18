import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Demo cast from the PRD: a seller, a buyer, Grace the client, David the freelancer. */
async function main(): Promise<void> {
  const people = [
    { phone: '+2348010000001', name: 'Seller (Tunde)', isSeller: true, payoutRef: '+2348010000001' },
    { phone: '+2348010000002', name: 'Buyer (Ada)', isBuyer: true },
    { phone: '+2348010000003', name: 'Grace (client)', isBuyer: true },
    { phone: '+2348010000004', name: 'David (freelancer)', isSeller: true, payoutRef: '+2348010000004' },
    { phone: '+2348010000009', name: 'Amana admin', isAdmin: true },
  ];

  for (const person of people) {
    await prisma.user.upsert({
      where: { phone: person.phone },
      update: person,
      create: { ...person, verifiedAt: new Date() },
    });
  }

  console.log(`Seeded ${people.length} demo users.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
