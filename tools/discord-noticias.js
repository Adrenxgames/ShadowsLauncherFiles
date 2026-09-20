/**
 * Gera o noticias.json que alimenta a aba de Noticias do launcher, lendo as
 * mensagens de um canal de anuncios do Discord.
 *
 * O launcher NAO fala com o Discord: um token de bot dentro do launcher estaria
 * na maquina de todo jogador. Quem fala e este script, de dentro do GitHub
 * Actions do repositorio ShadowsLauncherFiles, e o que chega no jogador e um
 * JSON estatico servido pelo raw.githubusercontent.com.
 *
 *     #anuncios  ->  este script (a cada 10 min)  ->  noticias/noticias.json
 *                                                          |
 *                                        aba Noticias do launcher (landing.js)
 *
 * O formato de saida e o que o loadDiscordNews/normalizeDiscordArticle do
 * app/assets/js/scripts/landing.js ja sabe ler - por isso nada muda no
 * launcher: e so apontar o campo "discordNews" do distribution.json para o
 * arquivo publicado.
 *
 * Duas coisas nao obvias que este script resolve:
 *
 *  1. IMAGEM DO DISCORD EXPIRA. Desde 2023 os links do cdn.discordapp.com vem
 *     assinados (?ex=...&hm=...) e morrem em 24h. Se o JSON guardasse o link,
 *     a noticia perderia a imagem no dia seguinte. Por isso cada imagem e
 *     BAIXADA e guardada no repositorio com o nome derivado do conteudo; o
 *     JSON aponta para o raw.githubusercontent.com, que nao expira. De quebra,
 *     o JSON so muda quando a noticia muda de verdade - senao o Actions
 *     commitaria links novos a cada 10 minutos, para sempre.
 *
 *  2. CONTEUDO VAZIO SEM ERRO. Sem a intent "Message Content" ligada no portal
 *     do Discord, a API responde 200 com content: "" em toda mensagem. O
 *     script detecta esse caso e falha com a explicacao, em vez de publicar
 *     noticias em branco.
 *
 * Uso:
 *     DISCORD_TOKEN=... node tools/discord-noticias.js [--saida <pasta>]
 *
 * Opcoes:
 *     --saida <pasta>       onde escrever noticias.json e imagens/ (padrao: o
 *                           campo "saida" do tools/noticias.config.json)
 *     --config <arquivo>    outro arquivo de configuracao
 *     --sem-imagens         nao baixa imagem nenhuma (util para conferir texto)
 *     --url-imagens <base>  troca o urlBaseImagens da configuracao
 *     --exemplo             nao fala com o Discord: escreve tres noticias de
 *                           mentira. E o que o ensaio local usa para mostrar a
 *                           aba funcionando antes de existir bot nenhum.
 */

const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')

const RAIZ = path.join(__dirname, '..')
const CONFIG_PADRAO = path.join(__dirname, 'noticias.config.json')

const API = 'https://discord.com/api/v10'
const AGENTE = 'ShadowsLauncher (https://github.com/Adrenxgames/ShadowsLauncher, 1.0)'

// Tipos de mensagem que sao texto de gente: DEFAULT e REPLY. O resto e recado
// do proprio Discord ("fulano entrou no servidor", pin, boost) e nao e noticia.
const TIPOS_DE_TEXTO = new Set([0, 19])

const EXTENSOES_DE_IMAGEM = /\.(apng|avif|gif|jpe?g|png|webp)$/i

const cores = {
    verde:    '\x1b[32m',
    amarelo:  '\x1b[33m',
    vermelho: '\x1b[31m',
    cinza:    '\x1b[90m',
    reset:    '\x1b[0m'
}

const log = (msg) => console.log(msg)
const detalhe = (msg) => log(`${cores.cinza}    ${msg}${cores.reset}`)

function erroFatal(msg){
    console.error(`\n${cores.vermelho}ERRO: ${msg}${cores.reset}\n`)
    process.exit(1)
}

/* -------------------------------------------------------------------------
 * Texto da mensagem
 * ---------------------------------------------------------------------- */

/**
 * Deixa o texto do Discord no formato que o renderDiscordMarkdown do launcher
 * entende. Ele ja cobre negrito, italico, codigo, spoiler, listas, titulos com
 * #, links e mencoes de usuario/cargo/canal. Sobra o que ele nao conhece:
 *
 *  - emoji custom  <:nome:123> / <a:nome:123>  apareceria cru na tela
 *  - horario       <t:1712345678:R>            idem
 *  - citacao       "> texto" / ">>> texto"     viraria paragrafo com > na frente
 */
function normalizarTexto(bruto){
    const texto = String(bruto == null ? '' : bruto).replace(/\r\n/g, '\n')

    return texto
        .split('\n')
        .map(linha => linha
            .replace(/^\s*>>>\s?/, '')
            .replace(/^\s*>\s?/, '')
            .replace(/<a?:([a-zA-Z0-9_]+):\d+>/g, ':$1:')
            .replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_, segundos) => formatarHorario(segundos))
            .replace(/\s+$/, '')
        )
        .join('\n')
        .trim()
}

function formatarHorario(segundos){
    const data = new Date(Number(segundos) * 1000)
    if(Number.isNaN(data.getTime())){
        return ''
    }
    // Fuso fixo: o Actions roda em UTC e o jogador esta no Brasil. Sem isto a
    // data publicada mudaria de dia dependendo de onde o script rodou.
    return data.toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    })
}

/**
 * Mesma limpeza que o stripDiscordFormatting do landing.js faz, porque o titulo
 * so e escondido do corpo da noticia se os dois baterem depois de limpos.
 */
function limparFormatacao(valor){
    return String(valor || '')
        .replace(/^#{1,6}\s+/, '')
        .replace(/^\s*-#\s*/, '')
        .replace(/\*\*|__|\|\|/g, '')
        .trim()
}

const LIMITE_TITULO = 120
const LIMITE_TITULO_CORTADO = 80

/**
 * O titulo sai da primeira linha da mensagem. Quando ela cabe, o launcher
 * reconhece que titulo e primeira linha sao a mesma coisa e nao repete o texto
 * no corpo. Quando nao cabe, o titulo vira um resumo cortado e o corpo fica
 * inteiro - repetir seria pior do que cortar.
 */
function deduzirTitulo(texto, padrao){
    const primeira = limparFormatacao(String(texto || '').split('\n').find(l => l.trim() !== '') || '')

    if(primeira === ''){
        return padrao
    }
    if(primeira.length <= LIMITE_TITULO){
        return primeira
    }
    return primeira.slice(0, LIMITE_TITULO_CORTADO).trimEnd() + '...'
}

/* -------------------------------------------------------------------------
 * Imagens
 * ---------------------------------------------------------------------- */

function pareceImagem(url, tipo){
    if(typeof tipo === 'string' && tipo.startsWith('image/')){
        return true
    }
    try {
        return EXTENSOES_DE_IMAGEM.test(new URL(url).pathname)
    } catch(err) {
        return false
    }
}

/**
 * Junta anexo e imagem de embed, sem repetir a mesma URL. Nao entra imagem que
 * o autor colou como link no meio do texto: la ela ja vira link clicavel, e
 * mostrar duas vezes polui a noticia.
 */
function imagensDaMensagem(mensagem){
    const encontradas = []

    for(const anexo of mensagem.attachments || []){
        if(anexo && anexo.url && pareceImagem(anexo.url, anexo.content_type)){
            encontradas.push(anexo.url)
        }
    }

    for(const embed of mensagem.embeds || []){
        for(const parte of [embed && embed.image, embed && embed.thumbnail]){
            if(parte && parte.url && pareceImagem(parte.url, null)){
                encontradas.push(parte.url)
            }
        }
    }

    return [...new Set(encontradas)]
}

/**
 * Texto que veio dentro de um embed (mensagem postada por outro bot, por
 * exemplo). Sem isto um anuncio bonito feito por webhook chegaria vazio.
 */
function textoDosEmbeds(mensagem){
    const partes = []

    for(const embed of mensagem.embeds || []){
        if(!embed){
            continue
        }
        if(embed.title){
            partes.push(`## ${embed.title}`)
        }
        if(embed.description){
            partes.push(embed.description)
        }
        for(const campo of embed.fields || []){
            if(campo && campo.name){
                partes.push(`**${campo.name}**`)
            }
            if(campo && campo.value){
                partes.push(campo.value)
            }
        }
    }

    return partes.join('\n\n')
}

/* -------------------------------------------------------------------------
 * Mensagem -> artigo
 * ---------------------------------------------------------------------- */

function autorDaMensagem(mensagem, config){
    if(config.autorFixo){
        return config.autorFixo
    }
    const autor = mensagem.author || {}
    return autor.global_name || autor.username || 'Shadows'
}

function linkDaMensagem(mensagem, canal, config){
    if(!config.guildId || String(config.guildId).startsWith('PREENCHER')){
        return null
    }
    return `https://discord.com/channels/${config.guildId}/${canal.id}/${mensagem.id}`
}

/**
 * Devolve o artigo no formato do normalizeDiscordArticle do launcher, ou null
 * quando a mensagem nao e noticia.
 */
function mensagemParaArtigo(mensagem, canal, config){
    if(!mensagem || !TIPOS_DE_TEXTO.has(mensagem.type)){
        return null
    }
    if(config.apenasFixados && !mensagem.pinned){
        return null
    }
    if(config.ignorarBots && mensagem.author && mensagem.author.bot){
        return null
    }

    const cru = String(mensagem.content || '')
    const prefixo = config.ignorarPrefixo

    if(prefixo && cru.trimStart().startsWith(prefixo)){
        return null
    }

    const doEmbed = textoDosEmbeds(mensagem)
    const texto = normalizarTexto([cru, doEmbed].filter(p => p.trim() !== '').join('\n\n'))
    const imagens = imagensDaMensagem(mensagem)

    if(texto === '' && imagens.length === 0){
        return null
    }

    const artigo = {
        title: deduzirTitulo(texto, config.tituloPadrao || 'Novidade'),
        category: canal.categoria || 'Discord',
        author: autorDaMensagem(mensagem, config),
        timestamp: new Date(mensagem.timestamp).toISOString(),
        content: texto,
        images: imagens
    }

    const link = linkDaMensagem(mensagem, canal, config)
    if(link){
        artigo.link = link
    }

    return artigo
}

/* -------------------------------------------------------------------------
 * Discord
 * ---------------------------------------------------------------------- */

async function pedirDiscord(caminho, token){
    const resposta = await fetch(`${API}${caminho}`, {
        headers: {
            'Authorization': `Bot ${token}`,
            'User-Agent': AGENTE
        }
    })

    if(resposta.status === 429){
        const espera = Number(resposta.headers.get('retry-after') || 5)
        detalhe(`o Discord pediu para esperar ${espera}s`)
        await new Promise(r => setTimeout(r, (espera + 1) * 1000))
        return pedirDiscord(caminho, token)
    }

    if(resposta.status === 401){
        throw new Error('o Discord recusou o token (401). Confira o segredo DISCORD_TOKEN:\n'
            + '  e o token do BOT (Bot > Reset Token), nao o Client Secret nem o Application ID.')
    }

    if(resposta.status === 403){
        // ⭐ 403 tem causas diferentes que parecem a mesma, e o Discord JA diz qual e - no campo
        // "code" do corpo. Jogar o corpo fora e o que transforma cinco minutos de conserto em uma
        // tarde mexendo em permissao de canal a esmo:
        //
        //   50001 Missing Access      -> o bot nao ENXERGA o canal (ou nem esta no servidor)
        //   50013 Missing Permissions -> ele ve o canal, mas nao pode ler o historico
        //
        // Sao consertos diferentes: o primeiro e "Ver canal"/convite, o segundo e
        // "Ver historico de mensagens".
        const corpo = await resposta.json().catch(() => null)
        const codigo = corpo && corpo.code
        const dito = corpo && corpo.message ? `${corpo.message} (code ${codigo})` : 'sem detalhe'

        let pista
        if(codigo === 50001){
            pista = '  code 50001 = Missing Access: o bot NAO ENXERGA esse canal.\n'
                + '    - Se ele nem aparece na lista de membros do servidor, convide-o:\n'
                + '      https://discord.com/oauth2/authorize?client_id=<ID DA APLICACAO>&scope=bot&permissions=66560\n'
                + '    - Se ja esta no servidor: permissoes do CANAL (nao da categoria) > adicione o bot\n'
                + '      pelo nome dele, nao por cargo, e marque "Ver canal".\n'
                + '    - Confira tambem se o ID do canal em noticias.config.json e o canal que voce editou:\n'
                + '      Discord > Configuracoes > Avancado > Modo desenvolvedor, depois botao direito no\n'
                + '      canal > Copiar ID do canal.'
        } else if(codigo === 50013){
            pista = '  code 50013 = Missing Permissions: o bot VE o canal, mas nao pode ler o historico.\n'
                + '    Nas permissoes do canal, marque "Ver historico de mensagens".'
        } else {
            pista = '  O bot precisa de "Ver canal" e "Ver historico de mensagens" NESSE canal,\n'
                + '    e precisa estar no servidor.'
        }

        throw new Error(`o bot nao pode ler ${caminho} (403): ${dito}\n${pista}`)
    }

    if(resposta.status === 404){
        throw new Error(`canal nao encontrado (404) em ${caminho}.\n`
            + '  Confira o ID em tools/noticias.config.json e se o bot foi convidado para o servidor.')
    }

    if(!resposta.ok){
        throw new Error(`HTTP ${resposta.status} ${resposta.statusText} em ${caminho}`)
    }

    return resposta.json()
}

async function lerCanal(canal, config, token){
    const limite = Math.min(Math.max(Number(config.limitePorCanal) || 15, 1), 100)
    const mensagens = await pedirDiscord(`/channels/${canal.id}/messages?limit=${limite}`, token)

    if(!Array.isArray(mensagens)){
        throw new Error(`resposta inesperada do canal ${canal.id}`)
    }

    return mensagens
}

/**
 * A intent "Message Content" e privilegiada. Sem ela a API responde 200 com
 * content vazio em toda mensagem que nao mencione o bot - e o resultado seria
 * um noticias.json com titulos "Novidade" e corpo em branco, publicado sem
 * nenhum erro. Este teste transforma isso num erro barulhento.
 */
function conferirIntent(mensagens){
    const deGente = mensagens.filter(m => TIPOS_DE_TEXTO.has(m.type))

    if(deGente.length === 0){
        return
    }

    const todasVazias = deGente.every(m =>
        String(m.content || '').trim() === ''
        && (m.attachments || []).length === 0
        && (m.embeds || []).length === 0
    )

    if(todasVazias){
        throw new Error('o Discord devolveu ' + deGente.length + ' mensagens, todas com conteudo VAZIO.\n'
            + '  Isso e a intent que falta, nao um canal vazio:\n'
            + '  https://discord.com/developers/applications > seu app > Bot >\n'
            + '  Privileged Gateway Intents > MESSAGE CONTENT INTENT > ligar > Save.')
    }
}

/* -------------------------------------------------------------------------
 * Download e poda das imagens
 * ---------------------------------------------------------------------- */

function extensaoDaImagem(url, tipo){
    const porTipo = {
        'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
        'image/webp': '.webp', 'image/avif': '.avif', 'image/apng': '.apng'
    }[String(tipo || '').split(';')[0].trim().toLowerCase()]

    if(porTipo){
        return porTipo
    }

    try {
        const achado = new URL(url).pathname.match(EXTENSOES_DE_IMAGEM)
        if(achado){
            return achado[0].toLowerCase()
        }
    } catch(err) { /* url estranha: cai no padrao */ }

    return '.png'
}

/**
 * Baixa as imagens dos artigos e troca a URL do Discord pela do repositorio. O
 * nome do arquivo vem do sha256 do CONTEUDO, entao a mesma imagem postada duas
 * vezes ocupa um arquivo so, e reprocessar a mesma noticia nao gera diff.
 */
async function resolverImagens(artigos, pastaImagens, config, semImagens){
    const usadas = new Set()
    const limiteBytes = (Number(config.limiteImagemMB) || 8) * 1024 * 1024
    let baixadas = 0

    for(const artigo of artigos){
        if(semImagens){
            artigo.images = []
            continue
        }

        const finais = []

        for(const url of artigo.images){
            try {
                const resposta = await fetch(url, { headers: { 'User-Agent': AGENTE } })
                if(!resposta.ok){
                    detalhe(`imagem ignorada (HTTP ${resposta.status}): ${url.split('?')[0]}`)
                    continue
                }

                const dados = Buffer.from(await resposta.arrayBuffer())
                if(dados.length > limiteBytes){
                    detalhe(`imagem ignorada (${(dados.length / 1048576).toFixed(1)} MB, acima do limite)`)
                    continue
                }

                const nome = crypto.createHash('sha256').update(dados).digest('hex').slice(0, 16)
                    + extensaoDaImagem(url, resposta.headers.get('content-type'))
                const destino = path.join(pastaImagens, nome)

                if(!fs.existsSync(destino)){
                    fs.mkdirSync(pastaImagens, { recursive: true })
                    fs.writeFileSync(destino, dados)
                    baixadas++
                }

                usadas.add(nome)
                finais.push(`${String(config.urlBaseImagens || '').replace(/\/+$/, '')}/${nome}`)
            } catch(err) {
                detalhe(`imagem ignorada (${err.message})`)
            }
        }

        artigo.images = finais
    }

    return { usadas, baixadas }
}

/**
 * Apaga imagem que nenhuma noticia usa mais. So roda depois de a leitura ter
 * dado certo: podar com a lista pela metade apagaria imagem viva.
 */
function podarImagens(pastaImagens, usadas){
    if(!fs.existsSync(pastaImagens)){
        return []
    }

    const apagadas = []

    for(const nome of fs.readdirSync(pastaImagens)){
        if(!usadas.has(nome) && EXTENSOES_DE_IMAGEM.test(nome)){
            fs.unlinkSync(path.join(pastaImagens, nome))
            apagadas.push(nome)
        }
    }

    return apagadas
}

/* -------------------------------------------------------------------------
 * Montagem
 * ---------------------------------------------------------------------- */

function ordenarEcortar(artigos, total){
    return artigos
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, Math.max(Number(total) || 12, 1))
}

function lerArgumentos(argv){
    const opcoes = { saida: null, config: CONFIG_PADRAO, semImagens: false, urlImagens: null, exemplo: false }

    for(let i = 0; i < argv.length; i++){
        if(argv[i] === '--saida' && argv[i + 1]){
            opcoes.saida = argv[++i]
        } else if(argv[i] === '--config' && argv[i + 1]){
            opcoes.config = argv[++i]
        } else if(argv[i] === '--url-imagens' && argv[i + 1]){
            opcoes.urlImagens = argv[++i]
        } else if(argv[i] === '--sem-imagens'){
            opcoes.semImagens = true
        } else if(argv[i] === '--exemplo'){
            opcoes.exemplo = true
        }
    }

    return opcoes
}

/**
 * Tres noticias de mentira, para o ensaio local. O texto de proposito usa tudo
 * que o caminho real precisa aguentar: titulo com #, lista, negrito, link,
 * mencao, emoji custom e uma imagem - assim o ensaio nao passa por acaso.
 */
function noticiasDeExemplo(urlBaseImagens, temImagem){
    const agora = Date.now()
    const emDias = (d) => new Date(agora - d * 86400000).toISOString()

    return [
        {
            title: 'Servidor abre sabado as 20h',
            category: 'Anuncios',
            author: 'Equipe Shadows',
            timestamp: emDias(0),
            content: '# Servidor abre sabado as 20h\n\n'
                + 'A temporada nova comeca com **mapa limpo** e tres mods de combate.\n\n'
                + '- Wipe completo do mundo\n'
                + '- Profissoes novas\n'
                + '- Evento de abertura com premio\n\n'
                + 'Duvidas com <@123456789> ou em <#987654321>. Ate la :shadow:\n\n'
                + '-# Esta e uma noticia de exemplo do ensaio local.',
            images: temImagem ? [`${urlBaseImagens}/exemplo-logo.png`] : [],
            link: 'https://discord.gg/UMgp4MGtN2'
        },
        {
            title: 'Manutencao de terca',
            category: 'Anuncios',
            author: 'Equipe Shadows',
            timestamp: emDias(2),
            content: '# Manutencao de terca\n\n'
                + 'O servidor fica fora do ar por volta de uma hora enquanto trocamos a versao '
                + 'do NeoForge. O launcher avisa quando voltar.',
            images: [],
            link: 'https://discord.gg/UMgp4MGtN2'
        },
        {
            title: 'Regras atualizadas',
            category: 'Regras',
            author: 'Equipe Shadows',
            timestamp: emDias(5),
            content: '# Regras atualizadas\n\n'
                + 'Leia antes de entrar: a parte de construcao em area de spawn mudou.',
            images: [],
            link: 'https://discord.gg/UMgp4MGtN2'
        }
    ]
}

/**
 * Copia uma imagem que ja existe no launcher para a pasta de saida, so para o
 * ensaio ter uma imagem de verdade para servir. Devolve false quando nao acha.
 */
function prepararImagemDeExemplo(pastaImagens){
    const origem = path.join(RAIZ, 'app', 'assets', 'images', 'logo.png')

    if(!fs.existsSync(origem)){
        return false
    }

    fs.mkdirSync(pastaImagens, { recursive: true })
    fs.copyFileSync(origem, path.join(pastaImagens, 'exemplo-logo.png'))
    return true
}

function lerConfig(caminho){
    if(!fs.existsSync(caminho)){
        erroFatal(`configuracao nao encontrada: ${caminho}`)
    }
    try {
        return JSON.parse(fs.readFileSync(caminho, 'utf-8'))
    } catch(err) {
        erroFatal(`noticias.config.json esta com JSON invalido: ${err.message}`)
    }
}

function validarConfig(config){
    if(!Array.isArray(config.canais) || config.canais.length === 0){
        erroFatal('nenhum canal em "canais" do tools/noticias.config.json.')
    }

    const faltando = config.canais.filter(c => !c || !c.id || String(c.id).startsWith('PREENCHER'))
    if(faltando.length > 0){
        erroFatal('falta preencher o ID de canal em tools/noticias.config.json.\n'
            + '  No Discord: Configuracoes > Avancado > Modo desenvolvedor, depois\n'
            + '  botao direito no canal > Copiar ID do canal.')
    }

    if(!config.urlBaseImagens || String(config.urlBaseImagens).startsWith('PREENCHER')){
        erroFatal('falta "urlBaseImagens" em tools/noticias.config.json.')
    }
}

function escrever(saida, artigos){
    fs.mkdirSync(saida, { recursive: true })
    fs.writeFileSync(
        path.join(saida, 'noticias.json'),
        JSON.stringify({ articles: artigos }, null, 2) + '\n',
        'utf-8'
    )
}

async function main(){
    const opcoes = lerArgumentos(process.argv.slice(2))
    const config = lerConfig(path.resolve(opcoes.config))

    if(opcoes.urlImagens){
        config.urlBaseImagens = opcoes.urlImagens
    }

    const saidaBruta = opcoes.saida || config.saida || 'dist-noticias'
    const saida = path.isAbsolute(saidaBruta) ? saidaBruta : path.join(RAIZ, saidaBruta)
    const pastaImagens = path.join(saida, 'imagens')

    if(opcoes.exemplo){
        log(`\n${cores.amarelo}Noticias de EXEMPLO (nada foi lido do Discord)${cores.reset}\n`)

        const temImagem = prepararImagemDeExemplo(pastaImagens)
        const base = String(config.urlBaseImagens || '').replace(/\/+$/, '')
        const artigos = noticiasDeExemplo(base, temImagem)

        escrever(saida, artigos)

        detalhe(`${artigos.length} noticia(s) de exemplo em ${path.join(saida, 'noticias.json')}`)
        if(!temImagem){
            detalhe('sem imagem de exemplo: app/assets/images/logo.png nao foi encontrado')
        }
        log('')
        return
    }

    log(`\n${cores.verde}Noticias do Discord${cores.reset}\n`)

    validarConfig(config)

    const token = process.env.DISCORD_TOKEN
    if(!token){
        erroFatal('falta a variavel DISCORD_TOKEN.\n'
            + '  No GitHub: Settings > Secrets and variables > Actions > New repository secret.\n'
            + '  Para rodar aqui: $env:DISCORD_TOKEN="..." ; npm run noticias')
    }

    let artigos = []

    log(`${cores.verde}1. Lendo os canais${cores.reset}`)
    for(const canal of config.canais){
        let mensagens
        try {
            mensagens = await lerCanal(canal, config, token)
            conferirIntent(mensagens)
        } catch(err) {
            erroFatal(err.message)
        }

        const daqui = mensagens
            .map(m => mensagemParaArtigo(m, canal, config))
            .filter(Boolean)

        detalhe(`${canal.categoria || canal.id}: ${daqui.length} noticia(s) de ${mensagens.length} mensagem(ns)`)
        artigos.push(...daqui)
    }

    artigos = ordenarEcortar(artigos, config.totalMaximo)

    if(artigos.length === 0){
        log(`\n${cores.amarelo}Nenhuma noticia encontrada. O arquivo sai vazio (o launcher mostra "sem noticias").${cores.reset}`)
    }

    log(`\n${cores.verde}2. Imagens${cores.reset}`)
    const { usadas, baixadas } = await resolverImagens(artigos, pastaImagens, config, opcoes.semImagens)
    const apagadas = opcoes.semImagens ? [] : podarImagens(pastaImagens, usadas)

    detalhe(`${usadas.size} em uso, ${baixadas} baixada(s) agora, ${apagadas.length} apagada(s)`)

    escrever(saida, artigos)

    log(`\n${cores.verde}Pronto${cores.reset}`)
    detalhe(`${artigos.length} noticia(s) em ${path.join(saida, 'noticias.json')}`)
    for(const artigo of artigos){
        detalhe(`  [${artigo.category}] ${artigo.title}`)
    }
    log('')
}

if(require.main === module){
    main().catch(err => erroFatal(err.stack || err.message))
}

module.exports = {
    normalizarTexto,
    limparFormatacao,
    deduzirTitulo,
    pareceImagem,
    imagensDaMensagem,
    textoDosEmbeds,
    mensagemParaArtigo,
    conferirIntent,
    extensaoDaImagem,
    ordenarEcortar,
    lerArgumentos,
    noticiasDeExemplo,
    resolverImagens,
    podarImagens,
    TIPOS_DE_TEXTO
}
