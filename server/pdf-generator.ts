import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

interface BoardingPassData {
  firstName: string;
  lastName: string;
  reservationNumber: string;
  assignedSpace: string;
  arrival: string;
  departure: string;
  accessCode: string;
  validFrom: string;
  validTo: string;
}

export async function generateBoardingPassPDF(data: BoardingPassData): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const buffers: Buffer[] = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      // Generate QR Code
      const qrCodeDataUrl = await QRCode.toDataURL(data.accessCode, {
        width: 200,
        margin: 1,
        color: {
          dark: '#232321',
          light: '#FFFFFF'
        }
      });
      const qrCodeBuffer = Buffer.from(qrCodeDataUrl.split(',')[1], 'base64');

      // Colors
      const primaryRed = '#cc352a';
      const secondaryBlue = '#c8d5e9';
      const textBlack = '#232321';

      // Header with logo area
      doc
        .fillColor(primaryRed)
        .rect(0, 0, doc.page.width, 120)
        .fill();

      doc
        .fillColor('white')
        .fontSize(32)
        .font('Helvetica-Bold')
        .text('DreamBoks', 50, 40);

      doc
        .fontSize(16)
        .font('Helvetica')
        .text('Digital Key', 50, 80);

      // Guest Information
      let yPos = 160;

      doc
        .fillColor(textBlack)
        .fontSize(10)
        .font('Helvetica')
        .text('GUEST NAME', 50, yPos);

      doc
        .fontSize(20)
        .font('Helvetica-Bold')
        .text(`${data.firstName} ${data.lastName}`, 50, yPos + 15);

      // Reservation Number
      yPos += 60;
      doc
        .fontSize(10)
        .font('Helvetica')
        .text('RESERVATION NUMBER', 50, yPos);

      doc
        .fontSize(18)
        .font('Helvetica-Bold')
        .text(data.reservationNumber, 50, yPos + 15);

      // Space Assignment
      yPos += 60;
      doc
        .fontSize(10)
        .font('Helvetica')
        .text('SPACE ASSIGNMENT', 50, yPos);

      doc
        .fontSize(18)
        .font('Helvetica-Bold')
        .text(data.assignedSpace, 50, yPos + 15);

      // Access Code Box (highlighted)
      yPos += 70;
      doc
        .fillColor(secondaryBlue)
        .rect(40, yPos - 10, 260, 80)
        .fill();

      doc
        .fillColor(textBlack)
        .fontSize(12)
        .font('Helvetica-Bold')
        .text('ACCESS CODE', 50, yPos);

      doc
        .fillColor(primaryRed)
        .fontSize(40)
        .font('Helvetica-Bold')
        .text(data.accessCode, 50, yPos + 25);

      // QR Code
      doc.image(qrCodeBuffer, doc.page.width - 250, 160, { width: 180, height: 180 });

      doc
        .fillColor(textBlack)
        .fontSize(10)
        .font('Helvetica')
        .text('Scan to verify', doc.page.width - 250, 350, { width: 180, align: 'center' });

      // Check-in / Check-out times
      yPos += 100;
      const arrivalDate = new Date(data.arrival);
      const departureDate = new Date(data.departure);

      doc
        .fontSize(10)
        .font('Helvetica')
        .text('CHECK-IN', 50, yPos);

      doc
        .fontSize(14)
        .font('Helvetica-Bold')
        .text(
          arrivalDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
          50,
          yPos + 15
        );

      doc
        .fontSize(12)
        .font('Helvetica')
        .text(
          arrivalDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
          50,
          yPos + 35
        );

      doc
        .fontSize(10)
        .font('Helvetica')
        .text('CHECK-OUT', 200, yPos);

      doc
        .fontSize(14)
        .font('Helvetica-Bold')
        .text(
          departureDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
          200,
          yPos + 15
        );

      doc
        .fontSize(12)
        .font('Helvetica')
        .text(
          departureDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
          200,
          yPos + 35
        );

      // Footer
      yPos = doc.page.height - 100;
      doc
        .fillColor('#666666')
        .fontSize(9)
        .font('Helvetica')
        .text('Please keep this digital key for the duration of your stay.', 50, yPos, {
          width: doc.page.width - 100,
          align: 'center'
        });

      doc
        .fontSize(9)
        .text('Your access code is valid from check-in time until check-out time.', 50, yPos + 15, {
          width: doc.page.width - 100,
          align: 'center'
        });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
