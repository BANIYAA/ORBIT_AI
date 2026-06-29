import fetch from "node-fetch";

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}/api`;

async function runTest() {
  console.log("Creating 1000 tasks...");
  const tasks = [];
  for (let i = 0; i < 1000; i++) {
    tasks.push({
      id: `task_${i}`,
      title: `Task ${i}`,
      completed: false,
      importance: "low",
      duration: 30,
      createdAt: new Date().toISOString()
    });
  }

  console.log("Sending initial 1000 tasks...");
  let res = await fetch(`${BASE_URL}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tasks })
  });
  console.log("Initial payload status:", res.status);
  if (res.status !== 200) {
    console.log(await res.text());
  }

  console.log("Running 100 simultaneous updates...");
  const promises = [];
  for (let i = 0; i < 100; i++) {
    // Each update modifies a specific task's title
    const updatedTasks = [...tasks];
    updatedTasks[0] = { ...updatedTasks[0], title: `Task 0 Updated by ${i}` };
    
    promises.push(
      fetch(`${BASE_URL}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks: updatedTasks })
      }).then(r => r.status).catch(e => e.message)
    );
  }

  const results = await Promise.all(promises);
  const successCount = results.filter(r => r === 200).length;
  const failCount = results.length - successCount;
  console.log(`Results: ${successCount} successes, ${failCount} failures`);
  
  if (failCount > 0) {
    console.log("Some errors occurred:", results.filter(r => r !== 200));
  }

  // Verify count
  const getRes = await fetch(`${BASE_URL}/tasks`);
  const getData = await getRes.json();
  console.log(`Final task count in DB: ${(getData as any).tasks?.length}`);
}

runTest().catch(console.error);
