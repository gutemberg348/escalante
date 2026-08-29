import PDFDocument from 'pdfkit';
import dayjs from 'dayjs';
import { db } from '../database/index.js';

const weekdays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const colors = {
  navy: '#173750', teal: '#245e79', paleYellow: '#fff4b8', closedYellow: '#ffe600',
  closedHeader: '#dac500', grid: '#6993a6', lightGrid: '#afc4ce', vacancy: '#d51f32',
  vacancyBackground: '#fbe8e9', vacancyText: '#168257', special: '#d3202d', text: '#23343d', muted: '#657680',
};

function fitText(document, text, x, y, width, height, options = {}) {
  const fontSize = options.fontSize ?? 5.1;
  document.font(options.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize)
    .fillColor(options.color ?? colors.text)
    .text(String(text ?? ''), x + 2, y + Math.max(1, (height - fontSize) / 2 - 0.6), {
      width: width - 4, height: height - 1, align: options.align ?? 'left', ellipsis: true, lineBreak: false
    });
}

function drawCell(document, { x, y, width, height, fill = '#ffffff', border = colors.lightGrid, lineWidth = 0.35 }) {
  document.save().lineWidth(lineWidth).strokeColor(border).fillColor(fill)
    .rect(x, y, width, height).fillAndStroke().restore();
}

function scheduleStatus(competency, slots) {
  const homologated = slots.length > 0 && slots.every((slot) => Boolean(slot.homologated_at));
  return homologated || competency.status === 'HOMOLOGATED' ? 'HOMOLOGADA' : 'RASCUNHO — NÃO HOMOLOGADA';
}

export function buildSchedulePdf({ competency, slots }) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: 'A4', layout: 'portrait', margin: 0,
      info: { Title: `Escala dos Telefonistas — ${competency.name}`, Subject: 'Escala mensal de serviço', Creator: 'Painel de Escala' }
    });
    const chunks = [];
    document.on('data', (chunk) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);

    const tableX = 20;
    const tableWidth = document.page.width - 40;
    const columnWidths = [27, 31, 74, 106, 106, 105.5, 105.5];
    const columnTitles = ['Dia', 'Sem.', 'Período', '1ª posição', '2ª posição', '3ª coluna', '4ª coluna'];
    const releases = new Map(db.prepare(`SELECT service_date,third_column_open,fourth_column_open
      FROM schedule_pdf_column_releases WHERE competency_id=?`).all(competency.id).map((row) => [row.service_date, row]));
    const memberTypesBySlot = new Map();
    for (const row of db.prepare(`SELECT a.service_slot_id,a.position_number,a.service_type
      FROM assignments a JOIN service_slots s ON s.id=a.service_slot_id
      WHERE s.competency_id=? AND a.status='CONFIRMED'
      ORDER BY a.service_slot_id,a.position_number`).all(competency.id)) {
      const types = memberTypesBySlot.get(row.service_slot_id) ?? [];
      types[row.position_number - 1] = row.service_type;
      memberTypesBySlot.set(row.service_slot_id, types);
    }
    const updatedAt = dayjs().format('DD/MM/YYYY [às] HH:mm');

    document.rect(tableX, 20, tableWidth, 30).fill(colors.navy);
    document.font('Helvetica-Bold').fontSize(10).fillColor('#ffffff')
      .text(`ESCALA DOS TELEFONISTAS — ${competency.name.toUpperCase()}`, tableX, 30.5, { width: tableWidth, align: 'center', lineBreak: false });
    document.rect(tableX, 50, tableWidth, 14).fill(colors.paleYellow).strokeColor('#ddc867').lineWidth(0.35).stroke();
    document.font('Helvetica-Bold').fontSize(6.1).fillColor('#8c5916')
      .text(`${scheduleStatus(competency, slots)} | VERSÃO 1 | Atualizada em ${updatedAt}`, tableX, 54.5, { width: tableWidth, align: 'center', lineBreak: false });
    let x = tableX;
    const headerY = 67; const headerHeight = 18;
    for (let index = 0; index < columnWidths.length; index += 1) {
      const extra = index >= 5;
      drawCell(document, { x, y: headerY, width: columnWidths[index], height: headerHeight, fill: extra ? colors.closedHeader : colors.teal, border: colors.grid, lineWidth: 0.45 });
      fitText(document, columnTitles[index], x, headerY, columnWidths[index], headerHeight, { bold: true, fontSize: 5.4, color: extra ? '#453d00' : '#ffffff', align: 'center' });
      x += columnWidths[index];
    }

    const rowsByDate = [];
    for (const slot of slots) {
      const current = rowsByDate.at(-1);
      if (current?.serviceDate === slot.service_date) current.slots.push(slot);
      else rowsByDate.push({ serviceDate: slot.service_date, slots: [slot] });
    }
    const footerY = 817;
    const rowHeight = Math.min(11.55, (footerY - headerY - headerHeight) / Math.max(slots.length, 1));
    let rowY = headerY + headerHeight;

    for (const [dayIndex, day] of rowsByDate.entries()) {
      const date = dayjs(day.serviceDate);
      const release = releases.get(day.serviceDate);
      const openFourth = Boolean(release?.fourth_column_open);
      const openThird = Boolean(release?.third_column_open || openFourth);
      const special = day.slots.some((slot) => Boolean(slot.is_majorado)) || [0, 5, 6].includes(date.day());
      // Mantém os dois turnos do mesmo dia como uma faixa visual única.
      const dayFill = dayIndex % 2 === 0 ? '#ffffff' : '#e2eff5';
      const dayLabelFill = dayIndex % 2 === 0 ? '#edf6fa' : '#cfe3ed';
      const mergedHeight = rowHeight * day.slots.length;
      x = tableX;
      for (const [value, width] of [[date.format('D'), columnWidths[0]], [weekdays[date.day()], columnWidths[1]]]) {
        drawCell(document, { x, y: rowY, width, height: mergedHeight, fill: dayLabelFill, border: colors.lightGrid, lineWidth: 0.32 });
        fitText(document, value, x, rowY, width, mergedHeight, { bold: special, fontSize: 5.2, color: special ? colors.special : colors.text, align: 'center' });
        x += width;
      }

      for (let periodIndex = 0; periodIndex < day.slots.length; periodIndex += 1) {
        const slot = day.slots[periodIndex];
        const names = slot.members ?? [];
        const memberTypes = memberTypesBySlot.get(slot.id) ?? [];
        const values = [
          slot.period === 'DIURNO' ? '07h00 às 19h00' : '19h00 às 07h00',
          names[0] ?? 'VAGA', names[1] ?? 'VAGA',
          openThird ? (names[2] ?? 'VAGA') : 'TRANCADA',
          openFourth ? (names[3] ?? 'VAGA') : 'TRANCADA'
        ];
        const periodY = rowY + rowHeight * periodIndex;
        x = tableX + columnWidths[0] + columnWidths[1];
        for (let column = 0; column < values.length; column += 1) {
          const tableColumn = column + 2;
          const closed = (tableColumn === 5 && !openThird) || (tableColumn === 6 && !openFourth);
          const vacancy = tableColumn >= 3 && values[column] === 'VAGA';
          const extraAssignment = column >= 3 || (column === 2 && memberTypes[1] === 'EXTRAORDINARY');
          drawCell(document, {
            x, y: periodY, width: columnWidths[tableColumn], height: rowHeight,
            fill: closed ? colors.closedYellow : vacancy ? colors.vacancyBackground : dayFill,
            border: colors.lightGrid, lineWidth: 0.32
          });
          fitText(document, values[column], x, periodY, columnWidths[tableColumn], rowHeight, {
            bold: column === 0 && special || vacancy || closed, fontSize: 4.9,
            color: closed ? '#5a4e00' : vacancy ? colors.vacancyText : extraAssignment || column === 0 && special ? colors.special : colors.text,
            align: column === 0 || vacancy || closed ? 'center' : 'left'
          });
          x += columnWidths[tableColumn];
        }
      }
      // A separação reforçada é desenhada uma única vez após os dois turnos do dia.
      document.save().strokeColor('#527b91').lineWidth(1.2)
        .moveTo(tableX, rowY + mergedHeight).lineTo(tableX + tableWidth, rowY + mergedHeight).stroke().restore();
      rowY += mergedHeight;
    }

    document.end();
  });
}
