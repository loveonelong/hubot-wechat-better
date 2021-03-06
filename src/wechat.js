// Wechat Bot: https://github.com/nodeWechat/wechat4u

const { Adapter, TextMessage, User } = require('hubot/es2015')
const WechatBot = require('wechat4u')
const fs = require('fs')
const path = require('path')
const qrcodeTerminal = require('qrcode-terminal')
const botemail = require('./botemail')

// Get Administrator email
let ADMINER_EMAIL
try {
  ADMINER_EMAIL = require(path.resolve(process.cwd(), './bot.config.js')).adminerEmail
} catch (e) {
  ADMINER_EMAIL = ''
}

class WechatAdapter extends Adapter {
  run (...args) {
    this.wechatBotRun(...args)
  }

  wechatBotRun ({ reRun } = {}) {
    // Wechat bot init
    if (!reRun) {
      try {
        this.wechatBot = new WechatBot(require(path.resolve(process.cwd(), './loginToken.json')))
      } catch (e) {
        this.wechatBotRun({ reRun: true })
        return
      }
    } else {
      this.robot.logger.info('重启wechatBot')
      this.wechatBot = new WechatBot()
    }

    // Bind events
    this.wechatBot.on('error', err => {
      // TODO: refactor
      this.robot.logger.error(err)
      if (err.tips === '微信初始化失败') {
        this.wechatBotRun({ reRun: true })
      }
      if (err.tips === '获取手机确认登录信息失败') {
        throw new Error('获取手机确认登录信息失败')
      }
    })
    this.wechatBot.on('uuid', this.qrcodeLogin.bind(this))
    this.wechatBot.on('login', () => {
      let wechatNickName = this.wechatBot.user.NickName
      if (this.robot.name !== wechatNickName) {
        this.robot.name = wechatNickName
      }

      this.robot.logger.info(`Wechat Bot Login Successed...`)

      // Save login token file
      fs.writeFileSync(path.resolve(process.cwd(), './loginToken.json'), JSON.stringify(this.wechatBot.botData))
      this.wechatBot.on('message', this.handlerMessage.bind(this))

      this.emit('connected')
    })

    // start
    if (this.wechatBot.PROP.uin) {
      this.wechatBot.restart()
    } else {
      this.wechatBot.start()
    }

    this.robot.logger.info(`Wechat Bot Adapter Started...`)
  }

  send (envelope, ...strings) {
    const text = strings.join()
    let bot = this.wechatBot
    bot
      .sendMsg(text, envelope.user.id)
      .then(res => {
        this.robot.logger.info(`Sending message to room: ${envelope.room}`)
      })
      .catch(err => {
        this.robot.logger.error(`Sending message to room: ${envelope.room} ${err}`)
      })
  }

  reply (envelope, ...strings) {
    this.send(envelope, ...strings)
  }

  /**
   * Push messages
   *
   * @param {any} msg
   * @param {any} [{ rule, type = 'all'|'group'|'friend', reg = true}={}]
   * @returns Promise
   * @memberof WechatAdapter
   */
  push (msg, { rule, type = 'all', reg = true } = {}) {
    return new Promise((resolve, reject) => {
      let contacts = this.wechatBot.contacts
      let envelopes = []

      let ids = Object.keys(contacts)

      // Filter ids by type, and exclude official accounts.
      switch (type) {
        case 'group':
          ids = ids.filter(id => id.match(/^@@/) && !this.wechatBot.Contact.isPublicContact(contacts[id]))
          break
        case 'friend':
          ids = ids.filter(id => !id.match(/^@@/) && !this.wechatBot.Contact.isPublicContact(contacts[id]))
          break
        default:
          ids = ids.filter(id => !this.wechatBot.Contact.isPublicContact(contacts[id]))
      }

      if (rule === undefined || rule === null) {
        ids.map(id => {
          let roomName = contacts[id].getDisplayName()
          envelopes.push({ room: roomName, user: { _id: id } })
        })
      } else {
        let matcher =
          typeof rule === 'function'
            ? rule
            : roomName => {
              return reg ? roomName.match(rule) : roomName === rule
            }
        ids.forEach(id => {
          let roomName = contacts[id].getDisplayName()
          if (matcher(roomName)) {
            envelopes.push({ room: roomName, user: { _id: id } })
          }
        })
      }
      envelopes.map(i => {
        this.robot.logger.info(`Sending message proactively to: ${i.room}.`)
        this.send(i, msg)
      })

      resolve(msg)
    })
  }

  createUser (contact, msg) {
    let opts, targetUser
    opts = {
      // Get the real name
      room: contact.getDisplayName(msg.FromUserName)
    }

    if (msg.FromUserName.match(/^@@/)) {
      // Get target user from  message of group.
      targetUser = msg.Content.slice(0, msg.Content.indexOf(':'))
      opts.name = targetUser
    } else {
      targetUser = contact.getDisplayName()
      opts.name = targetUser
    }
    return new User(msg.FromUserName, opts)
  }

  async handlerMessage (msg) {
    const bot = this.wechatBot
    const contact = bot.contacts[msg.FromUserName]

    // Exclude bot's self message and official account.
    if (contact.isSelf || bot.Contact.isPublicContact(contact)) return

    const user = this.createUser(contact, msg)
    switch (msg.MsgType) {
      case bot.CONF.MSGTYPE_TEXT:
        this.robot.logger.info(msg.Content)

        let msgContent = msg.Content
        let atBotNameSignReg = new RegExp(`@${this.robot.name}`)

        if (msg.FromUserName.match(/^@@/)) {
          // Group msg like 'fromUserNickeName:\n msgcontent'
          // Get clean msg content
          msgContent = msg.Content.slice(msg.Content.indexOf(':\n') + 2)
          try {
            // Maybe the bot  has alias name in the group
            const res = await this.wechatBot.batchGetContact([
              { UserName: msg.ToUserName, EncryChatRoomId: msg.FromUserName }
            ])
            const aliasName = res[0].DisplayName
            if (aliasName !== this.robot.name) {
              atBotNameSignReg = new RegExp(`@${this.robot.name}|@${aliasName}`)
            }
          } catch (e) {
            this.robot.logger.error(e)
          }
        }

        // Fix hobut just match bot name in message header.
        if (msgContent.match(atBotNameSignReg)) {
          msgContent = `${this.robot.name} ${msgContent.replace(atBotNameSignReg, '')}`
        }
        this.receive(new TextMessage(user, msgContent, msg.MsgId))
        break
      case bot.CONF.MSGTYPE_IMAGE:
        this.robot.logger.debug('图片消息')
        break
      case bot.CONF.MSGTYPE_VOICE:
        this.robot.logger.debug('语音消息')
        break
      case bot.CONF.MSGTYPE_EMOTICON:
        this.robot.logger.debug('表情消息')
        break
      case bot.CONF.MSGTYPE_VIDEO:
      case bot.CONF.MSGTYPE_MICROVIDEO:
        this.robot.logger.debug('视频消息')
        break
      case bot.CONF.MSGTYPE_APP:
        this.robot.logger.debug('文件消息')
        break
      default:
        // TODO:
        // this.receive(new CatchAllMessage(user, msg.Content, msg.MsgId))
        break
    }
  }

  qrcodeLogin (uuid) {
    // qrcode image url
    let imageUrl = 'https://login.weixin.qq.com/qrcode/' + uuid

    // Login url in qrcode image
    let targetUrl = 'https://login.weixin.qq.com/l/' + uuid

    // Generate qrcode in terminal
    qrcodeTerminal.generate(
      targetUrl,
      {
        small: true
      },
      qrcode => {
        this.robot.logger.info('\n' + qrcode)
      }
    )

    // Send qrcode to adminer email
    botemail
      .send({
        to: ADMINER_EMAIL,
        subject: 'hubot 微信机器人扫码登录',
        html: `二维码:<br/><img src="${imageUrl}" />`
      })
      .then(res => {
        this.robot.logger.info('Email send login qrcode successed!')
      })
      .catch(e => {
        this.robot.logger.error(`Email send login qrcode error: ${e}`)
      })
  }

  restart () {
    return new Promise((resolve, reject) => {
      this.wechatBot.restart()
      resolve()
    })
  }
}

exports.use = robot => new WechatAdapter(robot)
