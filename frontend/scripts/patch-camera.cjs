const fs = require('fs');
const path = 'src/pages/DoorCamera.jsx';
let content = fs.readFileSync(path, 'utf8');

const oldBlock = `      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { exact: 'environment' },
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 15, max: 15 },
        },
      });
      streamRef.current = stream;`;

const newBlock = `      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { exact: 'environment' },
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 15, max: 15 },
          },
        });
      } catch (envError) {
        if (envError.name === 'OverconstrainedError' || envError.name === 'NotFoundError') {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: 'environment',
              width: { ideal: 640 },
              height: { ideal: 480 },
              frameRate: { ideal: 15, max: 15 },
            },
          });
        } else {
          throw envError;
        }
      }
      streamRef.current = stream;`;

if (content.includes(oldBlock)) {
  content = content.replace(oldBlock, newBlock);
  fs.writeFileSync(path, content, 'utf8');
  console.log('Patched successfully.');
} else {
  console.log('Could not find the exact block — file may already differ.');
}