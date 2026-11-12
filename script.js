import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
    getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
    signInWithEmailAndPassword, signOut, updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
    getFirestore, collection, query, where, getDocs, writeBatch, doc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = seletor => document.querySelector(seletor);
const pagina = location.pathname.split('/').pop() || 'index.html';
const ehPublica = pagina === 'index.html' || pagina === 'cadastro.html';
const DIAS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex'];
const HORAS = [8, 9, 10, 11];
const SALAS = [1, 2, 3, 4].map(id => ({ id, nome: 'Sala 0' + id }));
const ROTULOS = { livre: 'Livre', ocupada: 'Ocupada', minha: 'Sua', passado: '—' };
const dataBR = d => d.slice(8) + '/' + d.slice(5, 7);

// ---------- AUXILIARES DE DATA ----------
const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inicio = (data, hora) => new Date(`${data}T${String(hora).padStart(2, '0')}:00:00`);

// Segunda a sexta da semana atual (se for fim de semana, mostra a próxima semana)
function diasDaSemana() {
    const hoje = new Date(), dow = hoje.getDay();
    const segunda = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + (dow === 0 ? 1 : dow === 6 ? 2 : 1 - dow));
    return [0, 1, 2, 3, 4].map(i => fmt(new Date(segunda.getFullYear(), segunda.getMonth(), segunda.getDate() + i)));
}

// ---------- MENSAGENS DE ERRO ----------
function msgErro(e) {
    const m = {
        'auth/invalid-email': 'Email inválido',
        'auth/missing-password': 'Digite a senha',
        'auth/weak-password': 'Senha com 6+ caracteres',
        'auth/email-already-in-use': 'Este email já está cadastrado',
        'auth/invalid-credential': 'EMAIL OU SENHA INVALIDO',
        'auth/user-not-found': 'EMAIL OU SENHA INVALIDO',
        'auth/wrong-password': 'EMAIL OU SENHA INVALIDO',
        'auth/too-many-requests': 'Muitas tentativas. Aguarde um pouco e tente de novo',
        'auth/network-request-failed': 'Sem conexão com a internet',
        'permission-denied': 'SINTO MUITO, ESSE HORÁRIO JÁ ESTÁ RESERVADO (por outra pessoa ou por você em outra sala)',
        'unavailable': 'Sem conexão com o servidor'
    };
    return m[e.code] || ('Erro: ' + (e.message || e.code || 'desconhecido'));
}

// ---------- LOGIN / PROTEÇÃO DAS PÁGINAS ----------
const usuarioPronto = new Promise(res => { const off = onAuthStateChanged(auth, u => { off(); res(u); }); });

if ($('.btn-login') && pagina === 'index.html') {
    $('.btn-login').addEventListener('click', async () => {
        try {
            await signInWithEmailAndPassword(auth, $('#login').value.trim(), $('#senha').value);
            location.href = 'tela_de_consulta.html';
        } catch (e) { alert(msgErro(e)); }
    });
}

if ($('.btn-cadastrar')) {
    $('.btn-cadastrar').addEventListener('click', async () => {
        const nome = $('#nome').value.trim();
        if (!nome) return alert('Preencha o nome');
        try {
            const cred = await createUserWithEmailAndPassword(auth, $('#login').value.trim(), $('#senha').value);
            await updateProfile(cred.user, { displayName: nome });
            alert('CADASTRO REALIZADO!');
            location.href = 'tela_de_consulta.html';
        } catch (e) { alert(msgErro(e)); }
    });
}

if ($('.btn-deslogar')) {
    $('.btn-deslogar').addEventListener('click', async () => {
        await signOut(auth);
        location.href = 'index.html';
    });
}

if ($('.btn-consultar')) $('.btn-consultar').addEventListener('click', () => location.href = 'tela_status_reserva.html');
if ($('.btn-voltar')) $('.btn-voltar').addEventListener('click', () => location.href = 'tela_de_consulta.html');

// ---------- FUNÇÕES DO BANCO (Firestore) ----------
const idReserva = (sala, data, hora) => `${sala}_${data}_${hora}`;

async function reservasDaSala(sala) {
    const semana = diasDaSemana()[0];
    const snap = await getDocs(query(collection(db, 'reservas'), where('sala', '==', sala), where('semana', '==', semana)));
    return snap.docs.map(d => d.data());
}

async function minhasReservas() {
    const snap = await getDocs(query(collection(db, 'reservas'), where('uid', '==', auth.currentUser.uid)));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(r => inicio(r.data, r.hora).getTime() + 3600000 > Date.now())
        .sort((a, b) => a.data.localeCompare(b.data) || a.hora - b.hora);
}

async function reservar(sala, data, hora) {
    const uid = auth.currentUser.uid, dias = diasDaSemana();
    if (inicio(data, hora) < new Date()) throw new Error('Este horário já passou');
    const batch = writeBatch(db);
    batch.set(doc(db, 'reservas', idReserva(sala.id, data, hora)),
        { uid, sala: sala.id, salaNome: sala.nome, data, hora, semana: dias[0] });
    batch.set(doc(db, 'ocupacoes', `${uid}_${data}_${hora}`), { uid, data, hora });
    await batch.commit();
}

async function cancelar(r) {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'reservas', r.id));
    batch.delete(doc(db, 'ocupacoes', `${r.uid}_${r.data}_${r.hora}`));
    await batch.commit();
}

// ---------- CONSULTA: grade da semana (seg a sex, 8h-11h) ----------
async function carregarGrade() {
    const sala = Number($('#sala').value), dias = diasDaSemana(), uid = auth.currentUser.uid;
    let res;
    try { res = await reservasDaSala(sala); }
    catch (e) { $('#grade').innerHTML = '<p>' + msgErro(e) + '</p>'; return; }

    const status = (data, hora) => {
        const r = res.find(x => x.data === data && x.hora === hora);
        return inicio(data, hora) < new Date() ? 'passado' : !r ? 'livre' : r.uid === uid ? 'minha' : 'ocupada';
    };
    let html = '<table><tr><th>Hora</th>' + dias.map((d, i) => `<th>${DIAS[i]} ${dataBR(d)}</th>`).join('') + '</tr>';
    for (const h of HORAS) {
        html += `<tr><th>${h}:00</th>` + dias.map(d => {
            const s = status(d, h);
            return `<td><button class="slot ${s}" data-data="${d}" data-hora="${h}" data-status="${s}">${ROTULOS[s]}</button></td>`;
        }).join('') + '</tr>';
    }
    $('#grade').innerHTML = html + '</table>';
}

function iniciarConsulta() {
    $('#sala').innerHTML = SALAS.map(s => `<option value="${s.id}">${s.nome}</option>`).join('');
    carregarGrade();
    $('#sala').addEventListener('change', carregarGrade);

    $('#grade').addEventListener('click', async (event) => {
        const b = event.target.closest('.slot');
        if (!b) return;
        const { data, hora, status } = b.dataset;
        if (status === 'ocupada') return alert('A Sala já está reservada!');
        if (status === 'minha') return alert('Você já reservou este horário!');
        if (status === 'passado') return;
        const sala = SALAS.find(s => s.id === Number($('#sala').value));
        if (!confirm(`Deseja reservar ${sala.nome} em ${dataBR(data)} às ${hora}:00?`)) return;
        try {
            await reservar(sala, data, Number(hora));
            alert('RESERVA REALIZADA!');
        } catch (e) { alert(msgErro(e)); }
        carregarGrade();
    });
}

// ---------- STATUS: minhas reservas ----------
async function carregarReservas() {
    try {
        const lista = await minhasReservas();
        $('#lista').innerHTML = lista.length
            ? lista.map(r => `<li>${r.salaNome} - ${dataBR(r.data)} às ${r.hora}:00 <button data-id="${r.id}">CANCELAR</button></li>`).join('')
            : '<li>Você não tem reservas.</li>';
        return lista;
    } catch (e) { $('#lista').innerHTML = '<li>' + msgErro(e) + '</li>'; return []; }
}

function iniciarStatus() {
    carregarReservas();
    $('#lista').addEventListener('click', async (event) => {
        const id = event.target.dataset.id;
        if (!id || !confirm('Cancelar esta reserva?')) return;
        try {
            const [sala, data, hora] = id.split('_');
            await cancelar({ id, uid: auth.currentUser.uid, data, hora: Number(hora) });
        } catch (e) { alert(msgErro(e)); }
        carregarReservas();
    });
}

// ---------- LEMBRETE: avisa quando falta 1 hora (ou menos) ----------
async function iniciarLembretes() {
    let lista = [];
    const atualizar = async () => { try { lista = await minhasReservas(); } catch { /* ignora */ } };
    const checar = () => {
        const vistos = JSON.parse(localStorage.getItem('lembretesVistos') || '[]');
        for (const r of lista) {
            const minutos = Math.round((inicio(r.data, r.hora) - Date.now()) / 60000);
            if (minutos < 0 || minutos > 60 || vistos.includes(r.id)) continue;
            vistos.push(r.id);
            localStorage.setItem('lembretesVistos', JSON.stringify(vistos));
            alert(`LEMBRETE: sua reserva na ${r.salaNome} começa às ${r.hora}:00 (faltam ${minutos} min)`);
        }
    };
    await atualizar(); checar();
    setInterval(checar, 30000);
    setInterval(atualizar, 300000); // reconsulta o banco a cada 5 min
}

// ---------- ARRANQUE ----------
usuarioPronto.then(user => {
    if (ehPublica) {
        if (user && pagina === 'index.html') location.href = 'tela_de_consulta.html';
        return;
    }
    if (!user) { location.href = 'index.html'; return; }
    if ($('#sala')) iniciarConsulta();
    if ($('#lista')) iniciarStatus();
    iniciarLembretes();
});
